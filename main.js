// Copyright (c) 2013, Joyent, Inc. All rights reserved.

var fs = require('fs');

var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var once = require('once');
var vasync = require('vasync');
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

    assert.object(cfg.zookeeper, 'config.zookeeper');

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

    var cfg = opts.config;
    assert.arrayOfObject(cfg.services, 'cfg.services');
    var hosts = cfg.services;

    hosts.forEach(function (h) {
        h.hosts = [];
    });

    opts.log.debug({ hosts: hosts }, 'hosts');

    if (hosts.length === 0) {
        opts.log.info('No hosts to watch');
        cb();
        return;
    }

    function onHosts(change) {
        for (var h in hosts) {
            if (hosts[h].domain == change.domain) {
                hosts[h].hosts = change.hosts || [];
                break;
            }
        }

        var _opts = {
            adminIp: cfg.adminIp,
            changed: change.domain,
            externalIp: cfg.externalIp,
            hosts: hosts,
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
    }

    function _start(host, _cb) {
        _cb = once(_cb);

        var watch = new core.createWatch({
            domain: host.domain,
            log: opts.log,
            zk: opts.zk
        });
        watch.start(function onStart(err) {
            if (err) {
                _cb(err);
                return;
            }

            // ZooKeeper errors should redrive here.
            watch.on('error', function (err2) {
                opts.log.error({ err: err2, domain: watch.domainName },
                    'watch failed; stopping watch.');
                watch.stop();
            });

            watch.on('hosts', onHosts);

            _cb(null, watch);
        });
    }

    function start(host, _cb) {
        var retry = backoff.call(_start, host, _cb);
        retry.failAfter(Infinity);
        retry.setStrategy(new backoff.ExponentialStrategy());

        retry.on('backoff', function (num, delay, err) {
            opts.log.warn({
                err: err,
                num_attempts: num,
                delay: delay
            }, 'failed to start ZooKeeper watch');
        });

        opts.log.debug({ host: host }, 'starting watch');
        retry.start();
    }

    var pOpts = {
        func: start,
        inputs: hosts
    };

    vasync.forEachParallel(pOpts, cb);
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
            }, function (__, watchers) {
                zk.on('error', function onError(err) {
                    LOG.error(err, 'ZooKeeper: error');
                    if (watchers) {
                        watchers.forEach(function (w) {
                            w.stop();
                        });
                    }

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

    zookeeper();
})();
