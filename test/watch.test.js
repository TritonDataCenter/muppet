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
}

MockZookeeper.prototype.get = function (path, cb) {
    cb(null, this.res[path]);
};

MockZookeeper.prototype.isConnected = function () {
    return (true);
};

tap.test('test FIXME', function (t) {
    var zk = new MockZookeeper();
    var watcher = new watch.ServerWatcherFSM({
        zk: zk,
        path: '',
        log: log
    });

    watcher.on('serversChanged', function (servers) {
        console.log(servers);
        t.done();
    });

    zk.res['/c1'] = JSON.stringify({
	type: 'host', host: { address: '127.0.0.1' } });
    zk.res['/c2'] = JSON.stringify({
	type: 'host', host: { address: '127.0.0.2' } });

    console.log('here');
    watcher.childrenChanged(['c1', 'c2']);

});

// vim: set softtabstop=4 shiftwidth=4:
