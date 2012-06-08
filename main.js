// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');
var fs = require('fs');

var bunyan = require('bunyan');
var optimist = require('optimist');
var zkplus = require('zkplus');

var core = require('./lib');



///--- Globals

var ARGV = optimist.options({
        'd': {
                alias: 'debug',
                describe: 'debug level'
        },
        'f': {
                alias: 'file',
                describe: 'configuration file',
                demand: true
        }
}).argv;

var CFG;

var LOG = bunyan.createLogger({
        level: ARGV.d ? (ARGV.d > 1 ? 'trace' : 'debug') : 'info',
        name: 'muppet',
        serializers: {
                err: bunyan.stdSerializers.err
        },
        src: ARGV.d ? true : false,
        stream: process.stdout
});



///--- Internal Functions

function errorAndExit(err, msg) {
        LOG.fatal({err: err}, msg);
        process.exit(1);
}

function readConfig() {
        if (!CFG) {
                var cfg = fs.readFileSync(ARGV.f, 'utf8');
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

readConfig();
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
                        core.updateHAProxyConfig(hosts, function (updateErr) {
                                if (updateErr) {
                                        LOG.error({
                                                err: updateErr
                                        }, 'haproxy config update failed');
                                        return;
                                }

                                core.restartHAProxy(function (restartErr) {
                                        if (restartErr) {
                                                LOG.error({
                                                        err: restartErr
                                                }, 'haproxy restart failed');
                                                return;
                                        }

                                        LOG.info({
                                                hosts: hosts
                                        }, 'haproxy restarted');
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
