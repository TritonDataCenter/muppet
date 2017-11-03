/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */
var assert = require('assert-plus');
var zkstream = require('zkstream');

function createZKClient(cfg, cb) {
    assert.object(cfg, 'cfg');
    assert.object(cfg.log, 'cfg.log');
    assert.arrayOfObject(cfg.zookeeper.servers, 'cfg.zookeeper.servers');
    assert.ok((cfg.zookeeper.servers.length > 0), 'cfg.zookeeper.servers empty');
    assert.number(cfg.zookeeper.timeout, 'cfg.zookeeper.timeout');
    assert.func(cb, 'callback');

    var opts = {
        servers: [],
        log: cfg.log,
        sessionTimeout: cfg.zookeeper.timeout
    };
    
    cfg.zookeeper.servers.forEach(function (s) {
        // Support old zk-plus (host) or new zkstream (address) configs
        let _host = s.host || s.address;
        opts.servers.push({ address: _host, port: s.port });
    });

    cfg.log.debug({
        servers: opts.servers,
        timeout: opts.sessionTimeout
    }, 'Creating ZooKeeper client');

    cb(null, new zkstream.Client(opts));
}


///--- API

module.exports = {
    createZKClient: createZKClient
};
