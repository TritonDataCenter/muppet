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

    watcher.sw_smearTime = 0;
    watcher.sw_collectionTimeout = 500;

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
        t.equal(servers['c1'].address, '127.0.0.1');
        t.equal(servers['c2'].address, '127.0.0.2');
        t.done();
    });

    watcher.childrenChanged(['c1']);

    setTimeout(function () {
        watcher.childrenChanged(['c1', 'c2', 'c3']);
        setTimeout(function () {
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
        watcher.childrenChanged(['c1', 'c2']);
            setTimeout(function () {
            watcher.childrenChanged(['c1']);
            }, 100);
        }, 100);
    }, 800);

});

// FIXME: children non-host nodes are ignored

// FIXME: percentage threshold removal check

// FIXME: threshold throttle check

// FIXME: test hold time

// FIXME: check remove in oldest order

// FIXME: get NO_NODE handling

// FIXME: get other ZK error handling + re-connect
