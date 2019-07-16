/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const mod_fs = require('fs');
const mod_assert = require('assert-plus');
const mod_forkexec = require('forkexec');
const mod_net = require('net');
const mod_util = require('util');
const mod_zkstream = require('zkstream');
const mod_vasync = require('vasync');
const VError = require('verror');
const FSM = require('mooremachine').FSM;

/*
 * Timing parameters for our heuristic rules below (see the FSM state diagram
 * and explanation above ServerWatcherFSM).
 */
const COLLECTION_TIMEOUT = 15000;   /* ms */
const HOLD_TIME = 30000;            /* ms */
const REMOVAL_THROTTLE = 0.2;       /* 0.2 = 20% */
const RETRY_TIMEOUT = 15000;        /* ms */
const SMEAR = 5000;                 /* ms */
const FETCH_CONCURRENCY = 4;

/* Debugging: how many previous diffs to keep in memory */
const HISTORY_LENGTH = 32;


function diffArrays(s1, s2) {
    var idx1 = {};
    var idx2 = {};
    var out = { added: [], removed: [] };
    s1.forEach(function (val) {
        idx1[val] = true;
    });
    s2.forEach(function (val) {
        if (idx1[val] !== true)
            out.added.push(val);
        idx2[val] = true;
    });
    s1.forEach(function (val) {
        if (idx2[val] !== true)
            out.removed.push(val);
    });
    return (out);
}

function diffObjects(o1, o2) {
    var out = { added: {}, removed: {} };

    for (var key in o1) {
        if (o2[key] === undefined)
            out.removed[key] = o1[key];
    }

    for (key in o2) {
        if (o1[key] === undefined)
            out.added[key] = o2[key];
    }

    return (out);
}

/*
 * The ServerWatcherFSM manages turning the childrenChanged watch events into
 * a list of servers, emitted whenever we should reload haproxy.
 *
 * The server list looks like this:
 *
 * [
 *     '<zoneuuid>': {
 *         'address': <ip-address>
 *     },
 *     ...
 * ]
 *
 * which corresponds to a particular webapi zone's name and address.  The
 * port(s) and their meanings to haproxy are currently hard-coded when we
 * generate the config.
 *
 * We use a couple of rules/heuristics to control this list and the timing
 * of reloads to avoid causing unnecessary churn and outages.
 *
 * In particular:
 *
 *   - All changes to the server list are "collected"/spooled for
 *     COLLECTION_TIMEOUT milliseconds before being applied (this happens
 *     in FSM state 'collecting'). This has a few goals:
 *       1. Don't react to short transient glitches where a registrar loses
 *          its session but immediately re-registers
 *       2. Only reload once when a whole lot of servers come online at
 *          the same time
 *
 *   - Removals from the server list are throttled, first by time -- we ignore
 *     any removal for HOLD_TIME milliseconds and only actually remove it from
 *     our servers list once that much time has elapsed (plus/minus the
 *     collection timeout). This is double insurance against transient glitches.
 *
 *   - Removals are also throttled by percentage of server set removed -- if
 *     a fraction of the current list greater than REMOVAL_THROTTLE are removed
 *     at once, we only obey up to that fraction in any one reload, and we
 *     wait HOLD_TIME before looking again. This protects us against DC-wide
 *     ZK glitches where everything gets cut-off and has to re-register.
 *
 *
 *                  +
 *                  |
 *                  |
 *                  |
 *   ...            v
 *   &&
 *   throttle  +----------+
 *   or HOLD   |          |
 *  +--------> |   idle   |
 *  |          |          |
 *  |          +-+------+-+
 *  |            |      |
 *  |            |      |
 *  |            |      |
 *  |     server |      | childrenChanged
 *  |     expiry |      | && diff >0
 *  | (HOLD_TIME)|      |
 *  |            |      |
 *  |            v      v
 *  |
 *  |         +------------+
 *  |         |            |
 *  +-------> | collecting |
 *  | ...     |            |
 *  | &&      +-----+------+
 *  | childrenCh.   |
 *  |               |
 *  |               | timeout
 *  |               | (COLLECTION_TIMEOUT)
 *  |               |
 *  |               v
 *  |
 *  |          +---------+
 *  |          |         |
 *  |          |  fetch  | <---------------+ timeout
 *  |          |         |                 | (RETRY_TIMEOUT)
 *  |          +--+---+--+                 |
 *  |             |   |                    | zk 'connect'
 *  | got servers |   | error              |
 *  |          ok |   |                    |
 *  |      && ... |   |               +----+----+
 *  |             |   |               |         |
 *  +-------------+   +-------------> |  retry  |
 *                                    |         |
 *                                    +---------+
 */
function ServerWatcherFSM(opts) {
    this.sw_zk = opts.zk;
    this.sw_path = opts.path;
    this.sw_log = opts.log;

    this.sw_lastSeen = {};
    this.sw_lastServers = {};
    this.sw_lastKids = [];
    this.sw_kids = [];
    this.sw_history = [];
    this.sw_serverHistory = [];
    this.sw_nextExpiry = null;

    this.sw_lastError = null;

    this.sw_collectionTimeout = COLLECTION_TIMEOUT;
    this.sw_holdTime = HOLD_TIME;
    this.sw_retryTimeout = RETRY_TIMEOUT;
    this.sw_smearTime = SMEAR;

    FSM.call(this, 'idle');
}
mod_util.inherits(ServerWatcherFSM, FSM);

/*
 * We add Math.random() * SMEAR to most of the timeouts listed above to "smear"
 * them out a bit and randomize the load we put on zookeeper. This is meant to
 * keep lots of muppet processes from hammering it all at once.
 */
ServerWatcherFSM.prototype.smear = function (value) {
    return (Math.round(value + (Math.random() * this.sw_smearTime)));
};

ServerWatcherFSM.prototype.childrenChanged = function (kids) {
    this.sw_log.trace({kids: kids}, 'childrenChanged');
    this.emit('childrenChangedAsserted', kids);
};

ServerWatcherFSM.prototype._newDiff = function (diff) {
    this.sw_history.push({ time: new Date(), diff: diff });
    while (this.sw_history.length > HISTORY_LENGTH)
        this.sw_history.shift();
};

ServerWatcherFSM.prototype._newServerDiff = function (diff) {
    this.sw_serverHistory.push({ time: new Date(), diff: diff });
    while (this.sw_serverHistory.length > HISTORY_LENGTH)
        this.sw_serverHistory.shift();
};

ServerWatcherFSM.prototype.state_idle = function (S) {
    var self = this;
    var now = Date.now();
    /*
     * sw_nextExpiry would have been set last time we finished "fetch", only
     * if we ran into something that needs to expire (e.g. a HOLD_TIME
     * or REMOVAL_THROTTLE violation). If we don't run into either of those
     * it should have been set to null.
     */
    if (this.sw_nextExpiry !== null) {
        var delta = (this.sw_nextExpiry - now);
        if (delta > 0) {
            S.timeout(delta, function () {
                self.sw_log.info('expiry timeout reached (hold time/throttle)');
                S.gotoState('collecting');
            });
        } else {
            S.gotoState('collecting');
            return;
        }
    }
    /*
     * Other than through expiry, we only leave this state if the set of child
     * nodes in ZK changes.
     */
    S.on(this, 'childrenChangedAsserted', function (kids) {
        var diff = diffArrays(self.sw_lastKids, kids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self.sw_log.info('received change notification from ZK');
            self._newDiff(diff);
            self.sw_kids = kids;
            S.gotoState('collecting');
        }
    });
};

ServerWatcherFSM.prototype.state_collecting = function (S) {
    var self = this;
    this.sw_nextExpiry = null;
    var timeout = self.smear(self.sw_collectionTimeout);
    this.sw_log.info('collecting diff for %d sec...',
        timeout / 1000);
    /*
     * Keep collecting any further changes to the child nodes, but don't
     * transition until COLLECTION_TIMEOUT elapses.
     */
    S.on(this, 'childrenChangedAsserted', function (kids) {
        var diff = diffArrays(self.sw_kids, kids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self._newDiff(diff);
            self.sw_kids = kids;
        }
    });
    S.gotoStateTimeout(timeout, 'fetch');
};

/*
 * We have a new set of Zookeeper children. Process them against our last known
 * state, potentially keeping hold of some removed servers.
 */
ServerWatcherFSM.prototype._processRemovals = function (servers) {
    var self = this;
    var log = this.sw_log;

    var diff = diffObjects(self.sw_lastServers, servers);

    var now = Date.now();
    Object.keys(servers).forEach(function (name) {
        self.sw_lastSeen[name] = now;
    });

    /*
     * Sort the removed servers so that the ones we've seen least recently
     * (oldest/lowest lastSeen values) are at the front (lowest indices).
     * That is, we want it in ascending order of lastSeen value.
     *
     * If we hit the throttle below we will decide to only actually remove
     * the first N of these in their sorted order.
     *
     * We also take advantage of this sorting when looking at HOLD_TIME
     * enforcement.
     */
    var removed = Object.keys(diff.removed).sort(function (a, b) {
        if (self.sw_lastSeen[a] < self.sw_lastSeen[b])
            return (-1);
        if (self.sw_lastSeen[a] > self.sw_lastSeen[b])
            return (1);
        /* Sort by name if lastSeen is the same, to keep it consistent */
        if (a < b)
            return (-1);
        if (a > b)
            return (1);
        return (0);
    });

    if (removed.length > 0) {
        log.info({ removed: removed }, 'servers have been removed in ZK');
    }

    var nextExpiry = null;

    var rmThresh = Math.ceil(REMOVAL_THROTTLE *
        Object.keys(self.sw_lastServers).length);

    log.trace('checking removal throttle (removing %d, threshold %d)',
        removed.length, rmThresh);

    if (removed.length > rmThresh) {
        log.warn('throttling server removal to %d servers (tried to ' +
            'remove %d)', rmThresh, removed.length);
        /*
         * We want to only remove the first rmThresh entries on the removed
         * list, so we resurrect the rest of the list.
         *
         * Remember .slice(N) returns the *rest* of the list after chopping
         * off the first N.
         */
        var toRestore = removed.slice(rmThresh);
        toRestore.forEach(function (s) {
            servers[s] = self.sw_lastServers[s];
        });
        /* Those first entries are the ones actually removed now. */
        removed = removed.slice(0, rmThresh);
        /*
         * Come back in HOLD_TIME and look again if nothing else happens
         * to re-process the throttle.
         */
        nextExpiry = self.smear(now + self.sw_holdTime);
    }

    /*
     * Now check for HOLD_TIMEs on individual servers. The 'removed' array
     * is sorted so that the most recently seen entries are *last*, so we
     * work from the end of the list here (calling .pop()).
     */
    while (removed.length > 0) {
        var sname = removed.pop();
        var lastSeen = self.sw_lastSeen[sname];
        var delta = now - lastSeen;
        if (delta >= self.sw_holdTime) {
            break;
        }

        log.info('keeping removed server %s around for hold time (%d s)',
            sname, self.sw_holdTime / 1000);
        servers[sname] = self.sw_lastServers[sname];
        var exp = self.smear(lastSeen + self.sw_holdTime);
        if (nextExpiry === null || exp < nextExpiry)
            nextExpiry = exp;
    }

    /*
     * Always set sw_nextExpiry: if we didn't encounter anything that needs
     * to expire, we want it to go to null so that "idle" doesn't wake up
     * spuriously.
     *
     * Note that if we're encountering errors that prevent us from ever
     * completing a run through fetch here (e.g. servers.length is 0), we
     * might leave this set and keep retrying from "idle" a lot.
     * That's fine.
     */
    self.sw_nextExpiry = nextExpiry;

    return (servers);
};

ServerWatcherFSM.prototype.state_fetch = function (S) {
    var self = this;
    var zk = this.sw_zk;
    var log = this.sw_log;

    /* Save the set of kids we're going to fetch now. */
    var kids = this.sw_kids;

    /*
     * If we receive another childrenChanged watch event while processing
     * this set of children, we should re-run this process again. We use this
     * 'repeat' variable to indicate this has happened.
     */
    var repeat = false;
    S.on(this, 'childrenChangedAsserted', function (nkids) {
        var diff = diffArrays(self.sw_lastKids, nkids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self._newDiff(diff);
            self.sw_kids = nkids;
            repeat = true;
        }
    });

    log.trace('fetching info about servers...');

    var servers = {};

    var opts = {
        worker: doKid,
        concurrency: FETCH_CONCURRENCY
    };

    this.sw_kidq = mod_vasync.queuev(opts);

    S.on(this.sw_kidq, 'end', S.callback(function () {
        if (servers.length === 0) {
            log.warn('tried to generate empty servers list, ignoring');
            S.gotoState('collecting');
            return;
        }

        servers = self._processRemovals(servers);

        var serverDiff = diffObjects(self.sw_lastServers, servers);
        self._newServerDiff(serverDiff);

        if (Object.keys(serverDiff.added).length !== 0 ||
            Object.keys(serverDiff.removed).length !== 0) {
            log.info({ diff: serverDiff }, 'servers have changed');
            self.sw_lastServers = servers;
            setImmediate(function () {
                self.emit('serversChanged', servers);
            });
        } else {
            log.info('no net change to servers detected');
        }

        if (repeat) {
            S.gotoState('collecting');
        } else {
            S.gotoState('idle');
        }
    }));
    kids.forEach(function (kid) {
        self.sw_kidq.push(kid);
    });
    self.sw_kidq.close();

    function doKid(name, cb) {
        const path = self.sw_path + '/' + name;
        zk.get(path, S.callback(function (err, json) {
            /*
             * The one error we can safely ignore here is NO_NODE, it just means
             * that we raced against another childrenChanged notification as
             * we entered the 'fetch' state, and one of the nodes went away.
             */
            if (err && err.name === 'ZKError' && err.code === 'NO_NODE') {
                log.debug({ path: path }, 'saw node in childrenChanged but ' +
                    'was missing at get()');
                cb();
                return;

            } else if (err) {
                /*
                 * Queues don't really give us a nice way to return an error and
                 * abort, but the kill() function is close. Note that the 'end'
                 * handler won't run after kill() so we transition here.
                 */
                self.sw_lastError = err;
                self.sw_kidq.kill();
                S.gotoState('retry');
                return;
            }

            try {
                var obj = JSON.parse(json.toString('utf-8'));
            } catch (e) {
                log.debug({ err: e, path: path }, 'failed parsing JSON in ' +
                    'ZK node, ignoring');
                cb();
                return;
            }
            /*
             * There are non-'host' type objects under the manta name as well,
             * which belong to load-balancer zones like ourselves.
             */
            if (typeof (obj) !== 'object' || obj.type !== 'host') {
                log.trace({ path: path }, 'not a host node');
                cb();
                return;
            }

            servers[name] = { address: obj.host.address };
            cb();
        }));
    }
};

ServerWatcherFSM.prototype.state_retry = function (S) {
    var self = this;
    this.sw_log.warn(this.sw_lastError, 'error while updating server list');
    S.on(this, 'childrenChangedAsserted', function (kids) {
        var diff = diffArrays(self.sw_kids, kids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self._newDiff(diff);
            self.sw_kids = kids;
        }
    });
    if (!this.sw_zk.isConnected()) {
        S.on(this.sw_zk, 'connect', function () {
            S.gotoStateTimeout(self.smear(0), 'fetch');
        });
        return;
    }
    S.gotoStateTimeout(self.smear(self.sw_retryTimeout), 'fetch');
};

module.exports = {
    ServerWatcherFSM: ServerWatcherFSM
};
