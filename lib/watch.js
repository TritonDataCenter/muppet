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

const mod_assert = require('assert-plus');
const mod_forkexec = require('forkexec');
const mod_fs = require('fs');
const mod_net = require('net');
const mod_path = require('path');
const mod_util = require('util');
const mod_vasync = require('vasync');
const mod_zkstream = require('zkstream');
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
 * The ServerWatcherFSM manages turning the nodesChanged watch events into
 * a list of servers, emitted whenever we should update haproxy.
 *
 * The server list looks like this:
 *
 * [
 *     '<zoneuuid>': {
 *         'kind': webapi|buckets-api
 *         'address': <ip-address>
 *         'ports': [...]
 *     },
 *     ...
 * ]
 *
 * which corresponds to a particular backend server.
 *
 * We use a couple of rules/heuristics to control this list and the timing
 * of updates to avoid causing unnecessary churn and outages.
 *
 * In particular:
 *
 *   - All changes to the server list are "collected"/spooled for
 *     COLLECTION_TIMEOUT milliseconds before being applied (this happens
 *     in FSM state 'collecting'). This has a few goals:
 *       1. Don't react to short transient glitches where a registrar loses
 *          its session but immediately re-registers
 *       2. Only update once when multiple servers change state at the same time
 *
 *   - Removals from the server list are throttled, first by time -- we ignore
 *     any removal for HOLD_TIME milliseconds and only actually remove it from
 *     our servers list once that much time has elapsed (plus/minus the
 *     collection timeout). This is double insurance against transient glitches.
 *
 *   - Removals are also throttled by percentage of server set removed -- if
 *     a fraction of the current list greater than REMOVAL_THROTTLE are removed
 *     at once, we only obey up to that fraction in any one update, and we
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
 *  |     server |      | nodesChanged
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
 *  | nodesChanged  |
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
    this.sw_log = opts.log;

    this.sw_lastSeen = {};
    this.sw_lastServers = {};
    this.sw_nodes = [];
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

ServerWatcherFSM.prototype.nodesChanged = function (path, nodes) {
    this.sw_log.trace({path: path}, {nodes: nodes}, 'nodesChanged');
    mod_assert.ok(!path.endsWith('/'));
    this.emit('nodesChangedAsserted', path, nodes);
};

ServerWatcherFSM.prototype._newServerDiff = function (diff) {
    this.sw_serverHistory.push({ time: new Date(), diff: diff });
    while (this.sw_serverHistory.length > HISTORY_LENGTH)
        this.sw_serverHistory.shift();
};

/*
 * Update a list of nodes given a new set, ignoring any under a different
 * prefix; returns true if something changed.
 */
ServerWatcherFSM.prototype._updateNodes = function (path, newnodes) {
    var self = this;
    var changed = false;

    self.sw_nodes = self.sw_nodes.filter(function (val) {
        if (mod_path.dirname(val) !== path ||
            newnodes.includes(mod_path.basename(val)))
            return (true);

        changed = true;
        return (false);
    });

    newnodes.forEach(function (val) {
        var node = path + '/' + val;
        if (!self.sw_nodes.includes(node)) {
            self.sw_nodes.push(node);
            changed = true;
        }
    });

    return (changed);
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
    S.on(this, 'nodesChangedAsserted', function (path, newnodes) {
        if (self._updateNodes(path, newnodes)) {
            self.sw_log.info('received change notification from ZK');
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
    S.on(this, 'nodesChangedAsserted', function (path, newnodes) {
        self._updateNodes(path, newnodes);
    });
    S.gotoStateTimeout(timeout, 'fetch');
};

/*
 * We have a new set of backend servers. Process them against our last known
 * state, potentially keeping hold of some removed servers.
 */
ServerWatcherFSM.prototype._processRemovals = function (servers) {
    var self = this;
    var log = this.sw_log;

    var diff = diffObjects(self.sw_lastServers, servers);

    var now = Date.now();
    for (var name in servers) {
        self.sw_lastSeen[name] = now;
    }

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

    /* Save the set of nodes we're going to fetch now. */
    var nodes = this.sw_nodes;

    /*
     * If we receive another nodesChanged watch event while processing
     * this set of nodes, we should re-run this process again. We use this
     * 'repeat' variable to indicate this has happened.
     */
    var repeat = false;
    S.on(this, 'nodesChangedAsserted', function (path, newnodes) {
        if (self._updateNodes(path, newnodes)) {
            repeat = true;
        }
    });

    log.trace('fetching info about servers...');

    var servers = {};
    var seen_error = false;

    var opts = {
        worker: getNode,
        concurrency: FETCH_CONCURRENCY
    };

    this.sw_nodeq = mod_vasync.queuev(opts);

    S.on(this.sw_nodeq, 'end', S.callback(function () {
        if (seen_error) {
            S.gotoState('retry');
            return;
        } else if (servers.length === 0) {
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
    nodes.forEach(function (node) {
        self.sw_nodeq.push(node);
    });
    self.sw_nodeq.close();

    function getNode(path, cb) {
        /* presume that any failure will need a pass through retry */
        if (seen_error) {
            cb();
            return;
        }

        zk.get(path, S.callback(function (err, json) {
            /*
             * The one error we can safely ignore here is NO_NODE, it just means
             * that we raced against another nodesChanged notification as
             * we entered the 'fetch' state, and one of the nodes went away.
             */
            if (err && err.name === 'ZKError' && err.code === 'NO_NODE') {
                log.debug({ path: path }, 'saw node in nodesChanged but ' +
                    'was missing at get()');
                cb();
                return;

            } else if (err) {
                /*
                 * Queues don't really give us a nice way to return an error and
                 * abort. We'll just mark ourselves as in error, and handle this
                 * in the 'end' callback.
                 */
                log.warn({ err: err }, 'got ZK error for ' + path);
                self.sw_lastError = err;
                seen_error = true;
                cb();
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

            mod_assert.object(obj);

            /*
             * We see ZK nodes like this:
             *
             * '/com/example/region/manta/<uuid>':
             *    { type: 'host', address: '<ip>', ports: [...] }
             *
             * '/com/example/region/buckets-api/<uuid>':
             *    { type: 'load_balancer', address: '<ip>',
             *      'load_balancer': { ports: [...] }
             *    }
             *
             * For 'webapi' backend servers, we're looking for host entries,
             * which correspond to the webapis.  There are also 'load_balancer'
             * entries, which are muppet entries we ignore, due to historical
             * confusion that led to both registering as 'manta'.
             *
             * 'buckets-api' backend servers are of the 'load_balancer' kind:
             * note this refers to the registration type given to registrar,
             * not anything haproxy-related.
             */

            const name = mod_path.basename(path);
            var kind = mod_path.basename(mod_path.dirname(path));

            if (kind === 'manta') {
                kind = 'webapi';
                if (obj.type !== 'host') {
                    log.trace({ path: path, obj: obj }, 'not a host node');
                    cb();
                    return;
                }

                mod_assert.string(obj.host.address);

                servers[name] = {
                    kind: kind,
                    address: obj.host.address
                };
            } else {
                mod_assert.equal(kind, 'buckets-api');
                if (obj.type !== 'load_balancer') {
                    log.trace({ path: path, obj: obj }, 'not an lb node');
                    cb();
                    return;
                }

                mod_assert.string(obj.load_balancer.address);
                mod_assert.array(obj.load_balancer.ports);

                servers[name] = {
                    kind: kind,
                    address: obj.load_balancer.address,
                    ports: obj.load_balancer.ports
                };
            }

            cb();
        }));
    }
};

ServerWatcherFSM.prototype.state_retry = function (S) {
    var self = this;
    this.sw_log.warn(this.sw_lastError, 'error while updating server list');
    S.on(this, 'nodesChangedAsserted', function (path, newnodes) {
        self._updateNodes(path, newnodes);
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
