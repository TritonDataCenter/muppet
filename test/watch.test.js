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

tap.test('test collecting serversChanged', function (t) {
    var zk = new MockZookeeper();
    var watcher = new watch.ServerWatcherFSM({
        zk: zk,
        path: '',
        log: log
    });

    watcher.on('serversChanged', function (servers) {
        t.equal(servers['c1'].address, '127.0.0.1');
        t.equal(servers['c2'].address, '127.0.0.2');
        t.done();
    });

    zk.res['/c1'] = JSON.stringify({
	type: 'host', host: { address: '127.0.0.1' } });
    zk.res['/c2'] = JSON.stringify({
	type: 'host', host: { address: '127.0.0.2' } });

    watcher.childrenChanged(['c1']);

    setTimeout(function () {
	watcher.childrenChanged(['c1', 'c2', 'c3']);
        setTimeout(function () {
            watcher.childrenChanged(['c1', 'c2']);
        }, 1000);
    }, 1000);
});

// FIXME: no net change

// FIXME: children non-host nodes are ignored

// FIXME: percentage threshold removal check

// FIXME: threshold throttle check

// FIXME: test hold time

// FIXME: check remove in oldest order

// FIXME: get NO_NODE handling

// FIXME: get other ZK error handling + re-connect

// vim: set softtabstop=4 shiftwidth=4:
