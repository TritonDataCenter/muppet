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

const lib_lbman = require('./lb_manager');
const lib_watch = require('./watch');
const lib_hasock = require('./haproxy_sock');

function domainToPath(domain) {
    return ('/' + domain.split('.').reverse().join('/'));
}

const MDATA_TIMEOUT = 30000;
const SETUP_RETRY_TIMEOUT = 30000;

function AppFSM(cfg) {
    this.a_log = cfg.log;

    this.a_adminIPs = cfg.adminIPS;
    this.a_mantaIPs = cfg.mantaIPS;
    this.a_trustedIP = cfg.trustedIP;
    this.a_untrustedIPs = [];
    if (cfg.hasOwnProperty('untrustedIPs'))
        this.a_untrustedIPs = cfg.untrustedIPs;
    this.a_zkCfg = cfg.zookeeper;
    this.a_name = cfg.name;
    this.a_path = domainToPath(cfg.name);
    this.a_lastError = null;
    this.a_beIdx = {};

    this.a_restartCmd = cfg.restart;

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
    this.a_nsf = new lib_watch.HostWatcherFSM({
        zk: this.a_zk,
        path: this.a_path,
        log: this.a_log
    });

    S.on(this.a_zk, 'session', function () {
        S.gotoState('watch');
    });
};

/*
 * We enter this state whenever we get a new ZK session, to create a new watcher
 * and then move to 'running' to resume normal operation.
 */
AppFSM.prototype.state_watch = function (S) {
    this.a_watcher = this.a_zk.watcher(this.a_path);
    S.gotoState('running');
};

AppFSM.prototype._restartLb = function (hosts) {
    var self = this;
    var log = this.a_log;
    const opts = {
        trustedIP: self.a_trustedIP,
        untrustedIPs: self.a_untrustedIPs,
        hosts: hosts,
        log: self.a_log.child({ component: 'lb_manager' }),
        restart: self.a_restartCmd
    };
    log.trace({ hosts: hosts }, 'going to restart lb');
    lib_lbman.restart(opts, function (err, beIdx) {
        if (err) {
            log.error(err, 'lb restart failed');
            return;
        }
        self.a_beIdx = beIdx;
        log.info({ hosts: hosts }, 'lb restarted');
    });
};

AppFSM.prototype.state_running = function (S) {
    var self = this;
    var log = this.a_log;

    S.on(this.a_watcher, 'childrenChanged', function (kids) {
        log.debug({ kids: kids }, 'childrenChanged fired');
        self.a_nsf.childrenChanged(kids);
    });

    S.on(this.a_nsf, 'hostsChanged', function (hosts, diff) {
        var newHosts = diff.added.filter(function (host) {
            return (self.a_beIdx[host] === undefined);
        });
        if (newHosts.length > 0) {
            self._restartLb(hosts);
        } else {
            var backends = {};
            for (var host in self.a_beIdx) {
                backends[self.a_beIdx[host]] = false;
            }
            hosts.forEach(function (host) {
                backends[self.a_beIdx[host]] = true;
            });
            const beopts = {
                log: self.a_log.child({ component: 'haproxy_sock' }),
                backends: backends
            };
            lib_hasock.syncBackendState(beopts, function (err) {
                if (err) {
                    log.error(err, 'failed to sync backend state with ' +
                        'haproxy control socket; falling back to restart');
                    self._restartLb(hosts);
                    return;
                }
                log.info({ hosts: hosts }, 'lb updated using control socket');
            });
        }
    });

    S.on(this.a_zk, 'session', function () {
        S.gotoState('watch');
    });
};

module.exports = {
    AppFSM: AppFSM
};
