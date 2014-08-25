/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var uuid = require('node-uuid');
var vasync = require('vasync');
var zkplus = require('zkplus');

var core = require('../lib');

if (require.cache[__dirname + '/helper.js'])
        delete require.cache[__dirname + '/helper.js'];
var helper = require('./helper.js');



///--- Globals

var after = helper.after;
var before = helper.before;
var test = helper.test;

var DOMAIN = 'watch.unit.test';
var PATH = '/test/unit/watch';

var WATCH;
var ZK;
var ZK2; // We need 2 ZK clients as ZK has crazy ordering of watches vs commits


///--- Tests

test('create zk', function (t) {
        helper.createZkClient(function (err, zk) {
                t.ifError(err);
                t.ok(zk);
                ZK = zk;
                t.end();
        });
});


test('create zk2', function (t) {
        helper.createZkClient(function (err, zk) {
                t.ifError(err);
                t.ok(zk);
                ZK2 = zk;
                t.end();
        });
});

test('create watch', function (t) {
        WATCH = core.createWatch({
                domain: DOMAIN,
                log: helper.createLogger(),
                zk: ZK
        });
        t.ok(WATCH);
        WATCH.start(function (err) {
                t.ifError(err);
                t.end();
        });
});


test('host addition', function (t) {
        WATCH.once('hosts', function (hosts) {
                t.ok(hosts);
                t.equal(hosts.length, 1);
                t.equal(hosts[0], '192.168.0.1');
                t.end();
        });

        var opts = {
                object: {
                        type: 'host',
                        host: {
                                address: '192.168.0.1'
                        }
                }
        };
        var p = PATH + '/1';
        ZK2.creat(p, opts, function (err) {
                t.ifError(err);
        });
});


test('host drop out', function (t) {
        var obj = {
                type: 'host',
                host: {
                        address: '192.168.0.2'
                }
        };
        ZK2.put(PATH + '/2', obj, function (err) {
                t.ifError(err);

                // We need to wait here otherwise the ZK
                // library will fire on the next invocation for the previous
                // add (i.e., when we set this watch, it potentially gets set
                // *before* the watch logic is done for the put above).
                setTimeout(function () {
                        WATCH.once('hosts', function (hosts) {
                                t.ok(hosts);
                                t.equal(hosts.length, 1);
                                t.equal(hosts[0], '192.168.0.2');
                                t.end();
                        });

                        ZK2.rmr(PATH + '/1', function (err2) {
                                t.ifError(err2);
                        });
                }, 500);
        });
});


test('tear down', function (t) {
        ZK.on('close', function () {
                ZK2.rmr('/test', function (err) {
                        ZK2.on('close', function () {
                                t.end();
                        });
                        ZK2.close();
                });
        });

        WATCH.stop();
        process.nextTick(function () {
                ZK.close();
        });
});
