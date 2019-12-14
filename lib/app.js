/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * muppet: this runs in the loadbalancer service and manages the HAProxy
 * configuration. It tracks the registrar-listed instances that are backend
 * servers to the load balancer.
 *
 * Rather than using DNS / binder, like other clients, we subscribe directly to
 * Zookeeper. This is probably for a few reasons, such as reducing load on
 * binder and avoiding the multi-stage timeouts from that path.
 *
 * When watch.js:serversChanged fires, we need to update haproxy. If we can, we
 * directly modify the running haproxy via haproxy_sock.js. If not, then we
 * "reload" haproxy via lb_manager.js.
 *
 * We also make sure the haproxy configuration is what we expect every
 * BESTATE_DOUBLECHECK ms.
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

const lib_lbman = require('./lb_manager');
const lib_watch = require('./watch');
/*
 * lib_haproxy_sock should be required once because it serializes operations
 * that accesses haproxy socket. Failing to do so may result in race conditions
 */
const lib_hasock = require('./haproxy_sock');
const lib_metrics = require('./metrics_exporter');

const MDATA_TIMEOUT = 30000;
const SETUP_RETRY_TIMEOUT = 30000;
const BESTATE_DOUBLECHECK = 30000;
const MAX_DIRTY_TIME = 6*3600*1000;

function AppFSM(cfg) {
    this.a_log = cfg.log;

    this.a_adminIPs = cfg.adminIPS;
    this.a_mantaIPs = cfg.mantaIPS;
    this.a_trustedIP = cfg.trustedIP;
    this.a_untrustedIPs = [];
    if (cfg.hasOwnProperty('untrustedIPs'))
        this.a_untrustedIPs = cfg.untrustedIPs;
    this.a_zkCfg = cfg.zookeeper;
    this.a_zkPrefix = '/' + cfg.domain.split('.').reverse().join('/') + '/';
    this.a_lastError = null;
    this.a_lastCleanTime = 0;
    this.a_servers = {};
    this.a_haproxyCfg = cfg.haproxy;

    this.a_reloadCmd = cfg.reload;

    if (cfg.metricsPort) {
        cfg.haSock = lib_hasock;
        this.a_metricsExporter = lib_metrics.createMetricsExporter(cfg);
        this.a_metricsExporter.start(function (err) {
            if (err) {
                cfg.log.fatal(err, 'failed to start metrics server');
                process.exit(1);
            }
        });
    }

    FSM.call(this, 'getips');
}
mod_util.inherits(AppFSM, FSM);

/*
 * Uses mdata-get or our configuration JSON to figure out which of our NIC IP
 * addresses are "untrusted" or "public" -- where we should be listening for
 * connections.
 */
AppFSM.prototype.state_getips = function (S) {
    var self = this;
    var log = this.a_log;
    // Allow hardcoding addresses in the configuration.
    if (this.a_untrustedIPs.length > 0) {
        S.gotoState('zksetup');
        return;
    }

    const args = [ '/usr/sbin/mdata-get', 'sdc:nics' ];
    log.info({ cmd: args }, 'Loading NIC information');
    mod_forkexec.forkExecWait({
        argv: args
    }, S.callback(function (err, info) {
        if (err) {
            self.a_lastError = new VError(err,
                'failed to load NIC information');
            S.gotoState('setuperr');
            return;
        }

        const nics = JSON.parse(info.stdout);
        mod_assert.array(nics, 'nics');

        function _pushIP(ip) {
            /* If this is an admin, manta, or other trusted IP, skip it. */
            if ((self.a_adminIPs && self.a_adminIPs.indexOf(ip) !== -1) ||
                (self.a_mantaIPs && self.a_mantaIPs.indexOf(ip) !== -1) ||
                ip === self.a_trustedIP)  {

                return;
            }

            if (!mod_net.isIPv4(ip) && !mod_net.isIPv6(ip)) {
                log.warn('invalid IP found in NIC information: "%s"', ip);
                return;
            }

            self.a_untrustedIPs.push(ip);
        }

        function _addIPsFromNics(nic) {
            if (nic.hasOwnProperty('ips')) {
                nic.ips.forEach(function parseIP(addr) {
                    _pushIP(addr.split('/')[0]);
                });
            } else if (nic.hasOwnProperty('ip')) {
                _pushIP(nic.ip);
            } else {
                log.warn({ nic: nic }, 'NIC has no IP addresses');
            }
        }

        nics.forEach(_addIPsFromNics);

        log.info({ ips: self.a_untrustedIPs },
            'selected IPs for untrusted networks');

        S.gotoState('zksetup');
    }));
    S.timeout(MDATA_TIMEOUT, function () {
        this.a_lastError = new Error('Timeout waiting for mdata-get exec');
        S.gotoState('setuperror');
    });
};

/* Sleeps and restarts the entire setup process. */
AppFSM.prototype.state_setuperror = function (S) {
    this.a_log.error(this.a_lastError, 'muppet startup failed: retry in 30sec');
    S.gotoStateTimeout(SETUP_RETRY_TIMEOUT, 'getips');
};

AppFSM.prototype.state_zksetup = function (S) {
    var opts = {
        servers: [],
        log: this.a_log,
        sessionTimeout: this.a_zkCfg.timeout
    };

    this.a_zkCfg.servers.forEach(function (s) {
        // Support old zk-plus (host) or new zkstream (address) configs
        var _host = s.address || s.host;
        opts.servers.push({ address: _host, port: s.port });
    });

    this.a_log.debug({
        servers: opts.servers,
        timeout: opts.sessionTimeout
    }, 'Creating ZooKeeper client');

    this.a_zk = new mod_zkstream.Client(opts);
    this.a_nsf = new lib_watch.ServerWatcherFSM({
        zk: this.a_zk,
        log: this.a_log
    });

    S.on(this.a_zk, 'session', function () {
        S.gotoState('watch');
    });
};

/*
 * We enter this state whenever we get a new ZK session, to create new watchers
 * and then move to 'running' to resume normal operation.
 */
AppFSM.prototype.state_watch = function (S) {
    this.a_webapi_watcher = this.a_zk.watcher(this.a_zkPrefix  + 'manta');
    this.a_buckets_watcher = this.a_zk.watcher(this.a_zkPrefix + 'buckets-api');
    S.gotoState('running');
};

AppFSM.prototype.state_running = function (S) {
    var self = this;
    var log = this.a_log;

    S.on(this.a_webapi_watcher, 'childrenChanged', function (nodes) {
        log.debug({ nodes: nodes }, 'webapi childrenChanged fired');
        self.a_nsf.nodesChanged(self.a_zkPrefix + 'manta', nodes);
    });

    S.on(this.a_buckets_watcher, 'childrenChanged', function (nodes) {
        log.debug({ nodes: nodes }, 'buckets childrenChanged fired');
        self.a_nsf.nodesChanged(self.a_zkPrefix + 'buckets-api', nodes);
    });

    S.on(this.a_zk, 'session', function () {
        S.gotoState('watch');
    });

    S.on(this.a_nsf, 'serversChanged', function (servers) {
        var new_servers = false;

        for (var name in self.a_servers) {
            if (servers[name] === undefined) {
                self.a_servers[name].enabled = false;
            }
        }

        for (name in servers) {
            if (self.a_servers[name] === undefined) {
                self.a_servers[name] = servers[name];
                new_servers = true;
            }

            self.a_servers[name].enabled = true;
        }

        /*
         * If new servers have been added that we've never seen before, we must
         * regenerate the configuration and reload haproxy.
         */
        if (new_servers) {
            S.gotoState('running.reload');
        } else {
            /*
             * But, if that's not the case, we can apply the change using the
             * stats socket. This makes us "dirty" because there are in-memory
             * changes not in the config file.
             */
            S.gotoState('running.dirty');
        }
    });

    /*
     * Periodically uses the stats socket to double-check that the haproxy
     * state in memory matches what we expect, unless we're reloading already.
     */
    S.interval(BESTATE_DOUBLECHECK, function () {
        if (Object.keys(self.a_servers).length === 0 || lib_lbman.reloading())
            return;
        const statopts = {
            log: self.a_log.child({ component: 'haproxy_sock' })
        };
        log.trace('doing periodic double-check of haproxy servers');
        lib_hasock.serverStats(statopts, function (err, srvs) {
            if (err) {
                log.error(err, 'failed to check server state with ' +
                    'haproxy control socket during periodic check');
                S.gotoState('running.dirty');
                return;
            }
            var res = checkStats(self.a_servers, srvs);
            if (res.wrong.length > 0 || res.reload) {
                log.warn(res, 'haproxy server state was out of sync during ' +
                    'periodic check');

                if (res.reload) {
                    S.gotoState('running.reload');
                } else {
                    S.gotoState('running.dirty');
                }
            } else {
                log.trace('periodic check ok');
            }
        });
    });
};

AppFSM.prototype.state_running.clean = function (S) {
    var self = this;
    this.a_lastCleanTime = Date.now();
    /*
     * We use lastCleanTime in running.dirty to decide how long it has been
     * since we were "last clean". That means it really needs to reflect when
     * we were last *in* running.clean, as opposed to when we last *entered*
     * it.
     *
     * If we only set it at the top of this state entry function then we won't
     * get this the way we want. Since we don't have state exit triggers in
     * mooremachine, just set up an interval timer here.
     */
    S.interval(5000, function () {
        self.a_lastCleanTime = Date.now();
    });
};

/*
 * Reload the config and then return to "running.clean" if everything is ok.
 *
 * Note that this is a sub-state of running, so it has all of its handlers.
 *
 * We can arbitrarily re-enter this state from various points, but
 * lib_lbman.reload() will itself serialize reloads.
 */
AppFSM.prototype.state_running.reload = function (S) {
    var self = this;
    var log = this.a_log;

    /*
     * We're going to reload, so disabled servers will be going away altogether.
     */

    var servers = {};

    for (var name in self.a_servers) {
        if (self.a_servers[name].enabled)
            servers[name] = self.a_servers[name];
    }

    self.a_servers = servers;

    const opts = {
        trustedIP: self.a_trustedIP,
        untrustedIPs: self.a_untrustedIPs,
        haproxy: self.a_haproxyCfg,
        servers: servers,
        log: self.a_log.child({ component: 'lb_manager' }),
        reload: self.a_reloadCmd
    };

    lib_lbman.reload(opts, S.callback(function (err) {
        if (err) {
            log.error(err, 'lb reload failed');
            S.gotoState('running.dirty');
            return;
        }
        log.info({ servers: servers }, 'lb config reloaded');

        S.gotoState('running.clean');
    }));
};

function hasDisabledServers(servers) {
    for (var name in servers) {
        if (servers[name].enabled === false)
            return (true);
    }
    return (false);
}

/*
 * We sit in this state when things are "dirty" (there has been a change to
 * the set of enabled servers that isn't in the config file).
 *
 * This state applies the change to the haproxy in-memory state and waits
 * for at most MAX_DIRTY_TIME before reloading.
 */
AppFSM.prototype.state_running.dirty = function (S) {
    var self = this;
    var log = this.a_log;

    var now = Date.now();
    var delta = now - this.a_lastCleanTime;
    if (delta > MAX_DIRTY_TIME && hasDisabledServers(self.a_servers)) {
        S.gotoState('running.reload');
        return;
    }

    var timeout = MAX_DIRTY_TIME - delta;
    S.timeout(timeout, function () {
        if (hasDisabledServers(self.a_servers)) {
            log.info('dirty changes to haproxy server set have persisted ' +
                'for MAX_DIRTY_TIME, will now reload');
            S.gotoState('running.reload');
        }
    });

    const syncopts = {
        log: self.a_log.child({ component: 'haproxy_sock' }),
        servers: self.a_servers
    };

    lib_hasock.syncServerState(syncopts, function (err) {
        if (err) {
            log.error(err, 'failed to sync server state with ' +
                'haproxy control socket; falling back to new config');
            S.gotoState('running.reload');
            return;
        }
        log.info({ servers: self.a_servers },
            'lb updated using control socket');
        /*
         * If we changed to a state where no servers are disabled then we're
         * back to being "clean" with respect to the config file.
         */
        if (!hasDisabledServers(self.a_servers))
            S.gotoState('running.clean');
    });
};

/*
 * Matches the output of lib_hasock.serverStats() against our idea of which
 * servers are in the haproxy config and whether they are enabled or disabled.
 */
function checkStats(servers, stats) {
    var wrong = [];
    var reload = false;
    stats.forEach(function (srv) {
        /*
         * Keep only select fields from the stat structure, so we can print
         * this out in the logs without it being ridiculously noisy.
         *
         * We replace the local so we make sure all fields we use for making
         * decisions here are in the log.
         */
        srv = {
            pxname: srv.pxname,
            svname: srv.svname,
            status: srv.status,
            addr: srv.addr
        };

        var server = lib_lbman.lookupSvname(servers, srv.svname);

        /*
         * If we've never heard of the svname, that means the config must be
         * really badly out of sync (not even same list of servers).
         */
        if (server === undefined) {
            wrong.push(srv);
            srv.reason = 'no-server';
            reload = true;
            return;
        }

        if (srv.addr.indexOf(server.address + ':') === -1) {
            wrong.push(srv);
            srv.reason = 'addr-mismatch';
            reload = true;
            return;
        }
        /*
         * Finally check that our enabled state is correct.
         */
        if (server.enabled && srv.status === 'MAINT') {
            wrong.push(srv);
            srv.reason = 'want-enabled';
            return;
        }
        if (!server.enabled && srv.status !== 'MAINT') {
            wrong.push(srv);
            srv.reason = 'want-disabled';
            return;
        }
    });

    return ({ wrong: wrong, reload: reload });
}

module.exports = {
    AppFSM: AppFSM,
    // for testing
    checkStats: checkStats
};
