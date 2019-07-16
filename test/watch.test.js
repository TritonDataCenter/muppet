/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var helper = require('./helper.js');
var tap = require('tap');
var watch = require('../lib/watch.js');

var log = helper.createLogger();

// tests run faster than real life
const COLLECTION_TIMEOUT = 500;
const HOLD_TIME = 3000;
const RETRY_TIMEOUT = 1500;
const SMEAR = 0;

function MockZookeeper() {
    this.res = {};
    this.connected = true;
}

MockZookeeper.prototype.get = function (path, cb) {
    cb(null, this.res[path]);
};

MockZookeeper.prototype.isConnected = function () {
    return (this.connected);
};

function setup(zk) {
    var watcher = new watch.ServerWatcherFSM({
        zk: new MockZookeeper(),
        path: '',
        log: log
    });

    watcher.sw_collectionTimeout = COLLECTION_TIMEOUT;
    watcher.sw_holdTime = HOLD_TIME;
    watcher.sw_retryTimeout = RETRY_TIMEOUT;
    watcher.sw_smearTime = SMEAR;

    return (watcher);
}

tap.test('test collecting serversChanged', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });

    watcher.on('serversChanged', function (servers) {
        t.comment('serversChanged: expecting c1,c2');
        t.equal(servers['c1'].address, '127.0.0.1');
        t.equal(servers['c2'].address, '127.0.0.2');
        t.done();
    });

    t.comment('adding c1');
    watcher.childrenChanged(['c1']);

    setTimeout(function () {
        t.comment('adding c2,c3');
        watcher.childrenChanged(['c1', 'c2', 'c3']);
        setTimeout(function () {
            t.comment('removing c3');
            watcher.childrenChanged(['c1', 'c2']);
        }, 100);
    }, 100);
});

tap.test('test no net change', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });

    t.comment('adding c1');
    watcher.childrenChanged(['c1']);

    // wait for the first notification, then proceed
    setTimeout(function () {
        watcher.on('serversChanged', function (servers) {
            t.fail('got serversChanged');
        });

        setTimeout(function () {
            t.done();
        }, 800);

        setTimeout(function () {
            t.comment('adding c2');
            watcher.childrenChanged(['c1', 'c2']);
            setTimeout(function () {
                t.comment('back to just c1');
                watcher.childrenChanged(['c1']);
            }, 100);
        }, 100);
    }, COLLECTION_TIMEOUT + 300);

});

tap.test('test hold time', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });
    watcher.sw_zk.res['/c3'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.3' }
    });

    t.comment('adding c1, c2');
    watcher.childrenChanged(['c1', 'c2']);

    var ok = false;

    setTimeout(function () {
        watcher.on('serversChanged', function (servers) {
            t.comment('got serversChanged with ok ' + ok);
            t.ok(ok, 'serversChanged expected');
            if (ok) {
                t.ok(servers['c1']);
                t.notOk(servers['c2']);
                t.done();
            }
        });

        setTimeout(function () {
            t.comment('removing c2');
            watcher.childrenChanged(['c1']);
            t.comment('expecting c2 to stay');

            setTimeout(function () {
                ok = true;
                t.comment('expecting c2 removal');
            }, COLLECTION_TIMEOUT + 300);
        }, COLLECTION_TIMEOUT + 300);
    }, COLLECTION_TIMEOUT + 300);

});

tap.test('test non-host children', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/c2'] = JSON.stringify({
        type: 'load_balancer', host: { address: '127.0.0.2' }
    });

    watcher.on('serversChanged', function (servers) {
        t.equal(servers['c1'].address, '127.0.0.1');
        t.notOk(servers['c2']);
        t.done();
    });

    t.comment('adding load_balancer c2');
    watcher.childrenChanged(['c1', 'c2']);
});

// FIXME: percentage threshold removal check

// FIXME: threshold throttle check

// FIXME: test hold time

// FIXME: check remove in oldest order

// FIXME: get NO_NODE handling

// FIXME: get other ZK error handling + re-connect
