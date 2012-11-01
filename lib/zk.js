// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var EventEmitter = require('events').EventEmitter;

var assert = require('assert-plus');
var backoff = require('backoff');
var zkplus = require('zkplus');



///--- Internal Functions

function heartbeat(opts, cb) {
        assert.object(opts, 'options');
        assert.object(opts.log, 'options.log');
        assert.object(opts.zk, 'options.zk');
        assert.func(cb, 'callback');

        var log = opts.log;
        var path = '/';

        log.debug({path: path}, 'heartbeat: entered');

        opts.zk.stat(path, function (err, stat) {
                if (err) {
                        log.warn({
                                err: err,
                                path: path
                        }, 'heartbeat: failed');
                        cb(err);
                } else {
                        log.debug({path: path}, 'heartbeat: ok');
                        cb();
                }
        });
}


function newZkClient(opts, cb) {
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        opts.autoReconnect = false;
        var client = zkplus.createClient(opts);
        var log = opts.log;

        function onConnect() {
                client.removeListener('error', onError);
                cb(null, client);
        }

        function onError(err) {
                client.removeListener('connect', onConnect);
                cb(err);
        }


        client.once('connect', onConnect);
        client.once('error', onError);
}



///--- API

function createZooKeeperClient(opts, cb) {
        assert.object(opts, 'options');
        assert.optionalNumber(opts.connectTimeout, 'options.connectTimeout');
        assert.object(opts.log, 'options.log');
        assert.arrayOfObject(opts.servers, 'options.servers');
        assert.number(opts.timeout, 'options.timeout');
        assert.func(cb, 'callback');

        assert.ok((opts.servers.length > 0), 'options.servers empty');
        for (var i = 0; i < opts.servers.length; i++) {
                assert.string(opts.servers[i].host, 'servers.host');
                assert.number(opts.servers[i].port, 'servers.port');
        }

        var done = false;
        if (!opts.emitter) {
                opts.emitter = new EventEmitter();
        }
        var log = opts.log;
        var t;

        function _cb(err) {
                if (done)
                        return;

                done = true;
                cb(err, err ? undefined : opts.emitter);
        }

        function onZooKeeperClient(zk_err, client) {
                if (zk_err) {
                        _cb(err);
                        return;
                }

                function cleanup(err) {
                        log.error({
                                err: err
                        }, 'ZooKeeper session closed; restarting');

                        clearInterval(t);
                        retry.abort();
                        client.removeAllListeners('close');
                        client.removeAllListeners('error');
                        client.removeAllListeners('session_expired');
                        client.close();
                        client = null;

                        process.nextTick(function () {
                                createZooKeeperClient(opts, function () {});
                        });
                }

                t = setInterval(function checkState() {
                        if (client === null)
                                return;

                        heartbeat({log: log, zk: client}, function (err) {
                                if (err) {
                                        cleanup();
                                }
                        });
                }, ((opts.timeout || 6000) / 2));

                client.once('close', cleanup);
                client.once('error', cleanup);
                client.once('session_expired', cleanup);

                process.nextTick(function () {
                        opts.emitter.emit('client', client);
                });

                _cb(null, opts.emitter);
        }

        var retry = backoff.call(newZkClient, opts, onZooKeeperClient);

        retry.failAfter(Infinity);

        retry.setStrategy(new backoff.ExponentialStrategy({
                initialDelay: 1000,
                maxDelay: 30000
        }));

        retry.on('backoff', function (number, delay) {
                var level;
                if (number < 5) {
                        level = 'warn';
                } else {
                        level = 'error';
                }
                log[level]({
                        attempt: number,
                        delay: delay
                }, 'zookeeper: connection attempted (failed)');
        });
}



///--- Exports

module.exports = {
        createZooKeeperClient: createZooKeeperClient
};
