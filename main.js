// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var fs = require('fs');

var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var getopt = require('posix-getopt');
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
var WATCH;
var ZK;



///--- CLI Functions

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
                        usage();
                        break;
                }
        }

        return (opts);
}


function readConfig(fname) {
        var cfg;
        var file;

        try {
                file = fs.readFileSync(fname, 'utf8');
        } catch (e) {
                LOG.fatal(e, 'unable to read %s', fname);
                process.exit(1);
        }
        try {
                cfg = JSON.parse(file);
        } catch (e) {
                LOG.fatal(e, 'invalid JSON in %s', fname);
                process.exit(1);
        }

        return (cfg);
}


function usage(msg) {
        if (msg)
                console.error(msg);

        var str = 'usage: ' + require('path').basename(process.argv[1]);
        str += '[-v] [-f file]';
        console.error(str);
        process.exit(1);
}



///--- Internal Functions

function onZooKeeperConnect() {
        LOG.info({
                zk: ZK.toString()
        }, 'ZooKeeper client acquired');

        if (WATCH) {
                WATCH.stop();
                WATCH = null;
        }

        WATCH = new core.createWatch({
                domain: CFG.name,
                log: LOG,
                zk: ZK
        });

        WATCH.start(function onStart(start_err) {
                if (start_err) {
                        LOG.fatal(start_err, 'unable to set watch');
                        process.exit(1);
                }

                WATCH.on('hosts', function onHosts(hosts) {
                        var opts = {
                                adminIp: CFG.adminIp,
                                externalIp: CFG.externalIp,
                                hosts: hosts || [],
                                log: LOG,
                                restart: CFG.restart
                        };
                        core.restartLB(opts, function (err) {
                                if (err) {
                                        LOG.error({
                                                hosts: hosts,
                                                err: err
                                        }, 'lb restart failed');
                                        return;
                                }

                                LOG.info({
                                        hosts: hosts
                                }, 'lb restarted');
                        });
                });
        });
}



///--- Mainline

var ARGV = parseOptions();
var CFG = readConfig(ARGV.file);

CFG.log = LOG;
CFG.zookeeper.log = LOG;

ZK = zkplus.createClient(CFG.zookeeper);

ZK.once('connect', onZooKeeperConnect);

ZK.connect();
