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
const VError = require('verror').VError;
const FSM = require('mooremachine').FSM;

/*
 * Timing parameters for our heuristic rules below (see the FSM state diagram
 * and explanation above HostWatcherFSM).
 */
const COLLECTION_TIMEOUT = 15000;   /* ms */
const HOLD_TIME = 30000;            /* ms */
const REMOVAL_THROTTLE = 0.2;       /* 0.2 = 20% */
const RETRY_TIMEOUT = 15000;        /* ms */
const FETCH_CONCURRENCY = 4;

/* Debugging: how many previous diffs to keep in memory */
const HISTORY_LENGTH = 32;

/*
 * We add Math.random() * SMEAR to most of the timeouts listed above to "smear"
 * them out a bit and randomize the load we put on zookeeper. This is meant to
 * keep lots of muppet processes from hammering it all at once.
 */
const SMEAR = 5000;                 /* ms */


function diffSets(list1, list2) {
    var idx1 = {};
    var idx2 = {};
    var out = { added: [], removed: [] };
    list1.forEach(function (val) {
        idx1[val] = true;
    });
    list2.forEach(function (val) {
        if (idx1[val] !== true)
            out.added.push(val);
        idx2[val] = true;
    });
    list1.forEach(function (val) {
        if (idx2[val] !== true)
            out.removed.push(val);
    });
    return (out);
}

/*
 * The HostWatcherFSM manages turning the childrenChanged watch events into
 * a list of hosts, emitted whenever we should restart haproxy.
 *
 * It uses a couple of rules/heuristics to control this list and the timing
 * of restarts to avoid causing unnecessary churn and outages.
 *
 * In particular:
 *
 *   - All changes to the backend list are "collected"/spooled for
 *     COLLECTION_TIMEOUT milliseconds before being applied (this happens
 *     in FSM state 'collecting'). This has a few goals:
 *       1. Don't react to short transient glitches where a registrar loses
 *          its session but immediately re-registers
 *       2. Only restart once when a whole lot of backends come online at
 *          the same time
 *
 *   - Removals from the backend list are throttled, first by time -- we ignore
 *     any removal for HOLD_TIME milliseconds and only actually remove it from
 *     our backends list once that much time has elapsed (plus/minus the
 *     collection timeout). This is double insurance against transient glitches.
 *
 *   - Removals are also throttled by percentage of backend set removed -- if
 *     a fraction of the current list greater than REMOVAL_THROTTLE are removed
 *     at once, we only obey up to that fraction in any one restart, and we
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
 *  |       host |      | childrenChanged
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
 *  |   got hosts |   | error              |
 *  |          ok |   |                    |
 *  |      && ... |   |               +----+----+
 *  |             |   |               |         |
 *  +-------------+   +-------------> |  retry  |
 *                                    |         |
 *                                    +---------+
 */
function HostWatcherFSM(opts) {
    this.hw_zk = opts.zk;
    this.hw_path = opts.path;
    this.hw_log = opts.log;

    this.hw_lastSeen = {};
    this.hw_lastHosts = [];
    this.hw_lastKids = [];
    this.hw_kids = [];
    this.hw_history = [];
    this.hw_hostHistory = [];
    this.hw_nextExpiry = null;

    this.hw_lastError = null;

    FSM.call(this, 'idle');
}
mod_util.inherits(HostWatcherFSM, FSM);

HostWatcherFSM.prototype.childrenChanged = function (kids) {
    this.emit('childrenChangedAsserted', kids);
};

HostWatcherFSM.prototype._newDiff = function (diff) {
    this.hw_history.push({ time: new Date(), diff: diff });
    while (this.hw_history.length > HISTORY_LENGTH)
        this.hw_history.shift();
};

HostWatcherFSM.prototype._newHostDiff = function (diff) {
    this.hw_hostHistory.push({ time: new Date(), diff: diff });
    while (this.hw_hostHistory.length > HISTORY_LENGTH)
        this.hw_hostHistory.shift();
};

HostWatcherFSM.prototype.state_idle = function (S) {
    var self = this;
    var now = Date.now();
    /*
     * hw_nextExpiry would have been set last time we finished "fetch", only
     * if we ran into something that needs to expire (e.g. a HOLD_TIME
     * or REMOVAL_THROTTLE violation). If we don't run into either of those
     * it should have been set to null.
     */
    if (this.hw_nextExpiry !== null) {
        var delta = (this.hw_nextExpiry - now);
        if (delta > 0) {
            S.timeout(delta, function () {
                self.hw_log.info('expiry timeout reached (hold time/throttle)');
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
        var diff = diffSets(self.hw_lastKids, kids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self.hw_log.info('received change notification from ZK');
            self._newDiff(diff);
            self.hw_kids = kids;
            S.gotoState('collecting');
        }
    });
};

HostWatcherFSM.prototype.state_collecting = function (S) {
    var self = this;
    this.hw_nextExpiry = null;
    var timeout = Math.round(COLLECTION_TIMEOUT + Math.random() * SMEAR);
    this.hw_log.info('collecting diff for %d sec...',
        timeout / 1000);
    /*
     * Keep collecting any further changes to the child nodes, but don't
     * transition until COLLECTION_TIMEOUT elapses.
     */
    S.on(this, 'childrenChangedAsserted', function (kids) {
        var diff = diffSets(self.hw_kids, kids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self._newDiff(diff);
            self.hw_kids = kids;
        }
    });
    S.gotoStateTimeout(timeout, 'fetch');
};

HostWatcherFSM.prototype.state_fetch = function (S) {
    var self = this;
    var zk = this.hw_zk;
    var log = this.hw_log;

    /* Save the set of kids we're going to fetch now. */
    var kids = this.hw_kids;

    /*
     * If we receive another childrenChanged watch event while processing
     * this set of children, we should re-run this process again. We use this
     * 'repeat' variable to indicate this has happened.
     */
    var repeat = false;
    S.on(this, 'childrenChangedAsserted', function (nkids) {
        var diff = diffSets(self.hw_lastKids, nkids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self._newDiff(diff);
            self.hw_kids = nkids;
            repeat = true;
        }
    });

    log.trace('fetching info about hosts...');

    var hosts = [];

    var opts = {
        worker: doKid,
        concurrency: FETCH_CONCURRENCY
    };
    this.hw_kidq = mod_vasync.queuev(opts);
    S.on(this.hw_kidq, 'end', S.callback(function () {
        if (hosts.length === 0) {
            log.warn('tried to generate empty backends list, ignoring');
            S.gotoState('collecting');
            return;
        }

        var hostDiff = diffSets(self.hw_lastHosts, hosts);

        var removed = hostDiff.removed;

        var now = Date.now();
        hosts.forEach(function (h) {
            self.hw_lastSeen[h] = now;
        });

        /*
         * Sort the removed hosts so that the ones we've seen least recently
         * (oldest/lowest lastSeen values) are at the front (lowest indices).
         * That is, we want it in ascending order of lastSeen value.
         *
         * If we hit the throttle below we will decide to only actually remove
         * the first N of these in their sorted order.
         *
         * We also take advantage of this sorting when looking at HOLD_TIME
         * enforcement.
         */
        removed = removed.sort(function (a, b) {
            if (self.hw_lastSeen[a] < self.hw_lastSeen[b])
                return (-1);
            if (self.hw_lastSeen[a] > self.hw_lastSeen[b])
                return (1);
            /* Sort by name if lastSeen is the same, to keep it consistent */
            if (a < b)
                return (-1);
            if (a > b)
                return (1);
            return (0);
        });

        if (removed.length > 0) {
            log.info({ removed: removed }, 'hosts have been removed in ZK');
        }

        var nextExpiry = null;

        var rmThresh = Math.ceil(REMOVAL_THROTTLE * self.hw_lastHosts.length);

        log.trace('checking removal throttle (removing %d, threshold %d)',
            removed.length, rmThresh);

        if (removed.length > rmThresh) {
            log.warn('throttling backend removal to %d backends (tried to ' +
                'remove %d)', rmThresh, removed.length);
            /*
             * We want to only remove the first rmThresh entries on the removed
             * list, so we take the rest of it and push it back into the
             * 'hosts' list (they were already missing from 'hosts', since this
             * came from the diff).
             *
             * Remember .slice(N) returns the *rest* of the list after chopping
             * off the first N
             */
            var toRestore = removed.slice(rmThresh);
            toRestore.forEach(function (h) {
                hosts.push(h);
            });
            /* Those first entries are the ones actually removed now. */
            removed = removed.slice(0, rmThresh);
            /*
             * Come back in HOLD_TIME and look again if nothing else happens
             * to re-process the throttle.
             */
            nextExpiry = Math.round(now + HOLD_TIME + Math.random() * SMEAR);
        }

        /*
         * Now check for HOLD_TIMEs on individual hosts. The 'removed' array
         * is sorted so that the most recently seen entries are *last*, so we
         * work from the end of the list here (calling .pop()).
         */
        while (removed.length > 0) {
            var host = removed.pop();
            var lastSeen = self.hw_lastSeen[host];
            var delta = now - lastSeen;
            if (delta < HOLD_TIME) {
                log.info('keeping removed host %s around for HOLD_TIME (%d s)',
                    host, HOLD_TIME / 1000);
                hosts.push(host);
                var exp = Math.round(lastSeen + HOLD_TIME +
                    Math.random() * SMEAR);
                if (nextExpiry === null || exp < nextExpiry)
                    nextExpiry = exp;
            } else {
                removed.push(host);
                break;
            }
        }

        /*
         * Always set hw_nextExpiry: if we didn't encounter anything that needs
         * to expire, we want it to go to null so that "idle" doesn't wake up
         * spuriously.
         *
         * Note that if we're encountering errors that prevent us from ever
         * completing a run through fetch here (e.g. hosts.length is 0), we
         * might leave this set and keep retrying from "idle" a lot.
         * That's fine.
         */
        self.hw_nextExpiry = nextExpiry;

        hostDiff = diffSets(self.hw_lastHosts, hosts);
        self._newHostDiff(hostDiff);

        if (hostDiff.added.length !== 0 || hostDiff.removed.length !== 0) {
            log.info({ diff: hostDiff }, 'making changes to hosts (after ' +
                'throttle and hold)');
            self.hw_lastHosts = hosts;
            setImmediate(function () {
                self.emit('hostsChanged', hosts, hostDiff);
            });
        } else {
            log.info('no net change to hosts detected, will not restart lb');
        }

        if (repeat) {
            S.gotoState('collecting');
        } else {
            S.gotoState('idle');
        }
    }));
    kids.forEach(function (kid) {
        self.hw_kidq.push(kid);
    });
    self.hw_kidq.close();

    function doKid(name, cb) {
        const path = self.hw_path + '/' + name;
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
                self.hw_lastError = err;
                self.hw_kidq.kill();
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
            hosts.push(obj.host.address);
            cb();
        }));
    }
};

HostWatcherFSM.prototype.state_retry = function (S) {
    var self = this;
    this.hw_log.warn(this.hw_lastError, 'error while updating backend list');
    S.on(this, 'childrenChangedAsserted', function (kids) {
        var diff = diffSets(self.hw_kids, kids);
        if (diff.added.length > 0 || diff.removed.length > 0) {
            self._newDiff(diff);
            self.hw_kids = kids;
        }
    });
    if (!this.hw_zk.isConnected()) {
        S.on(this.hw_zk, 'connect', function () {
            S.gotoStateTimeout(Math.round(Math.random() * SMEAR), 'fetch');
        });
        return;
    }
    const timeout = Math.round(RETRY_TIMEOUT + Math.random() * SMEAR);
    S.gotoStateTimeout(timeout, 'fetch');
};

module.exports = {
    HostWatcherFSM: HostWatcherFSM
};
