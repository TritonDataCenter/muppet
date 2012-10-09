// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var fs = require('fs');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var getopt = require('posix-getopt');
var zkplus = require('zkplus');

var core = require('./lib');



///--- Globals

var ARGV;
var CFG;
var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'muppet',
        stream: process.stderr,
        serializers: {
                err: bunyan.stdSerializers.err
        }
});



///--- Internal Functions

function errorAndExit(err, msg) {
        LOG.fatal({err: err}, msg);
        process.exit(1);
}


function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('vf:(file)', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'f':
                        opts.file = option.optarg;
                        break;

                case 'v':
                        // Allows us to set -vvv -> this little hackery
                        // just ensures that we're never < TRACE
                        LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
                        if (LOG.level() <= bunyan.DEBUG)
                                LOG = LOG.child({src: true});
                        break;

                default:
                        console.error('invalid option: ' + option.option);
                        process.exit(1);
                        break;
                }
        }

        ARGV = opts;
        return (opts);
}


function readConfig(opts) {
        if (!CFG) {
                var cfg = fs.readFileSync(opts.file, 'utf8');
                CFG = JSON.parse(cfg);
        }
        return (CFG);
}


function zkConnect(opts, callback) {
        var zk = zkplus.createClient({
                log: opts.log,
                servers: opts.zookeeper.servers,
                timeout: opts.zookeeper.timeout
        });
        zk.once('error', function onInitialError(err) {
                zk.removeAllListeners('connect');
                callback(err);
        });
        zk.once('connect', function onConnect() {
                zk.removeAllListeners('error');
                callback(null, zk);
        });
}



///--- Mainline

readConfig(parseOptions());

zkConnect({log: LOG, zookeeper: CFG.zookeeper}, function (zkErr, zk) {
        if (zkErr)
                errorAndExit(zkErr, 'Unable to connect to ZooKeeper');

        var watch = new core.createWatch({
                domain: CFG.name,
                log: LOG,
                zk: zk
        });

        watch.start(function (watchErr) {
                if (watchErr)
                        errorAndExit(watchErr, 'Unable to set watch');

                watch.on('hosts', function onHosts(hosts) {
                        core.updateLBConfig(hosts, function (updateErr) {
                                if (updateErr) {
                                        LOG.error({
                                                err: updateErr
                                        }, 'lb config update failed');
                                        return;
                                }

                                core.restartLB(function (restartErr) {
                                        if (restartErr) {
                                                LOG.error({
                                                        err: restartErr
                                                }, 'lb restart failed');
                                                return;
                                        }

                                        LOG.info({
                                                hosts: hosts
                                        }, 'lb restarted');
                                        return;
                                });
                                return;
                        });
                });
        });
});

process.on('uncaughtException', function (err) {
        errorAndExit(err, 'uncaughtException');
});
