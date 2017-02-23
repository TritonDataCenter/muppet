/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var fs = require('fs');

var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var forkexec = require('forkexec');
var net = require('net');
var once = require('once');
var zkplus = require('zkplus');

var core = require('./lib');



///--- Globals

var LOG = bunyan.createLogger({
    level: (process.env.LOG_LEVEL || 'info'),
    name: 'muppet',
    stream: process.stdout,
    serializers: {
        err: bunyan.stdSerializers.err
    }
});
var OPTIONS = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit.'
    },
    {
        names: ['verbose', 'v'],
        type: 'arrayOfBool',
        help: 'Verbose output. Use multiple times for more verbose.'
    },
    {
        names: ['file', 'f'],
        type: 'string',
        help: 'File to process',
        helpArg: 'FILE'
    }
];

///--- Helper functions

function getUntrustedIPs(cfg, callback) {
    // Allow hardcoding addresses in the configuration.
    if (cfg.hasOwnProperty('untrustedIPs')) {
        callback();
        return;
    }

    cfg.untrustedIPs = [];

    var args = [ '/usr/sbin/mdata-get', 'sdc:nics' ];
    LOG.info({ cmd: args }, 'Loading NIC information');
    forkexec.forkExecWait({
        argv: args
    }, function (err, info) {
        if (err) {
            LOG.error(info, 'Failed to load NIC information');
            setImmediate(callback, err);
            return;
        }

        var nics = JSON.parse(info.stdout);
        assert.array(nics, 'nics');

        LOG.info({ nics: nics }, 'Looked up NICs');

        nics.forEach(function (nic) {
            // Skip NICs on trusted networks.
            if (nic.nic_tag === 'admin' || nic.nic_tag === 'manta') {
                return;
            }

            if (nic.hasOwnProperty('ips')) {
                nic.ips.forEach(function (addr) {
                    var ip = addr.split('/')[0];
                    if (net.isIPv4(ip) || net.isIPv6(ip)) {
                        cfg.untrustedIPs.push(ip);
                    }
                });
            } else if (nic.hasOwnProperty('ip')) {
                if (net.isIPv4(nic.ip)) {
                    cfg.untrustedIPs.push(nic.ip);
                }
            } else {
                LOG.warn({ nic: nic }, 'NIC has no IP addresses');
            }
        });

        callback();
    });
}


///--- CLI Functions

function configure() {
    var cfg;
    var opts;
    var parser = new dashdash.Parser({options: OPTIONS});

    try {
        opts = parser.parse(process.argv);
        assert.object(opts, 'options');
    } catch (e) {
        LOG.fatal(e, 'invalid options');
        process.exit(1);
    }

    if (opts.help)
        usage();

    try {
        var _f = opts.file || __dirname + '/etc/config.json';
        cfg = JSON.parse(fs.readFileSync(_f, 'utf8'));
    } catch (e) {
        LOG.fatal(e, 'unable to parse %s', _f);
        process.exit(1);
    }

    assert.string(cfg.name, 'config.name');
    assert.string(cfg.trustedIP, 'config.trustedIP');
    assert.object(cfg.zookeeper, 'config.zookeeper');
    assert.optionalArrayOfString(cfg.untrustedIPs,
        'config.untrustedIPs');

    if (cfg.logLevel)
        LOG.level(cfg.logLevel);

    if (opts.verbose) {
        opts.verbose.forEach(function () {
            LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
        });
    }

    if (LOG.level() <= bunyan.DEBUG)
        LOG = LOG.child({src: true});

    cfg.log = LOG;
    cfg.zookeeper.log = LOG;

    return (cfg);
}


function usage(msg) {
    if (msg)
        console.error(msg);

    var str = 'usage: ' + require('path').basename(process.argv[1]);
    str += '[-v] [-f file]';
    console.error(str);
    process.exit(msg ? 1 : 0);
}



///--- Internal Functions

function startWatch(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.config, 'options.config');
    assert.object(opts.log, 'options.log');
    assert.object(opts.zk, 'options.zk');
    assert.func(cb, 'callback');

    cb = once(cb);

    function _start(_, _cb) {
        _cb = once(_cb);

        var cfg = opts.config;
        var watch = new core.createWatch({
            domain: cfg.name,
            log: opts.log,
            zk: opts.zk
        });
        watch.start(function onStart(startErr) {
            if (startErr) {
                _cb(startErr);
                return;
            }

            // ZooKeeper errors should redrive here.
            watch.on('error', function (err) {
                opts.log.error(err, 'watch failed; stopping watch.');
                watch.stop();
            });

            watch.on('hosts', function onHosts(hosts) {
                var _opts = {
                    trustedIP: cfg.trustedIP,
                    untrustedIPs: cfg.untrustedIPs,
                    hosts: hosts || [],
                    log: opts.log,
                    restart: cfg.restart
                };
                core.restartLB(_opts, function (err) {
                    if (err) {
                        opts.log.error({
                            hosts: hosts,
                            err: err
                        }, 'lb restart failed');
                        return;
                    }

                    opts.log.info({
                        hosts: hosts
                    }, 'lb restarted');
                });
            });

            _cb(null, watch);
        });
    }

    function start() {
        var retry = backoff.call(_start, {}, cb);
        retry.failAfter(Infinity);
        retry.setStrategy(new backoff.ExponentialStrategy());

        retry.on('backoff', function (num, delay, err) {
            opts.log.warn({
                err: err,
                num_attempts: num,
                delay: delay
            }, 'failed to start ZooKeeper watch');
        });

        retry.start();
    }

    start();
}



///--- Mainline

(function main() {
    var cfg = configure();

    function zookeeper() {
        function _zk(_, cb) {
            cb = once(cb);

            var zk = zkplus.createClient(cfg.zookeeper);

            zk.once('connect', function () {
                zk.removeAllListeners('error');
                LOG.info({
                    zk: zk.toString()
                }, 'ZooKeeper client acquired');

                cb(null, zk);
            });

            zk.once('error', function (err) {
                zk.removeAllListeners('connect');
                cb(err);
            });

            zk.connect();
        }

        var retry = backoff.call(_zk, {}, function (_, zk) {
            startWatch({
                config: cfg,
                log: LOG,
                zk: zk
            }, function (_dummy2, watcher) {
                zk.on('error', function onError(err) {
                    LOG.error(err, 'ZooKeeper: error');
                    if (watcher)
                        watcher.stop();

                    zk.close();

                    zk.removeAllListeners('connect');
                    zk.removeAllListeners('error');

                    process.nextTick(zookeeper);
                });
            });
        });
        retry.failAfter(Infinity);
        retry.setStrategy(new backoff.ExponentialStrategy());

        retry.on('backoff', function (num, delay, err) {
            LOG.warn({
                err: err,
                num_attempts: num,
                delay: delay
            }, 'failed to create ZooKeeper client');
        });

        retry.start();
    }

    getUntrustedIPs(cfg, function (err) {
        if (err) {
            // We failed to load our IPs: abort.
            LOG.fatal(err, 'Failed to look up any IPs');
            process.exit(1);
        }

        LOG.info({
            trustedIP: cfg.trustedIP,
            untrustedIPs: cfg.untrustedIPs
        }, 'Selected IPs for untrusted networks');

        zookeeper();
    });
})();
