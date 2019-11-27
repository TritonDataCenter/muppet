/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Note that all tests here are based upon test/haproxy.cfg.test configuration.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const app = require('../lib/app.js');
const haproxy_sock = require('../lib/haproxy_sock.js');
const helper = require('./helper.js');
const tap = require('tap');

var log = helper.createLogger();

tap.beforeEach(function (cb, t) {
    helper.startHaproxy(cb);
});

tap.afterEach(function (cb, t) {
    helper.killHaproxy(cb);
});

tap.test('app.checkStats no-server', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            'kind': 'webapi',
            'enabled': true,
            'address': '127.0.0.1'
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            'kind': 'buckets-api',
            'enabled': true,
            'address': '127.0.0.1'
        }
        // intentionally missing
        // '5c679a71-9ef7-4079-9a4c-45c9f5b97d45': { 'enabled': true }
    };

    haproxy_sock.serverStats({ log: log }, function (err, stats) {
        t.notOk(err);

        const res = app.checkStats(servers, stats);

        t.equal(res.reload, true, 'must reload');
        t.equal(res.wrong.length, 2, 'one wrong server in 2 backends');
        t.equal(res.wrong[0].svname,
            '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
        t.equal(res.wrong[0].reason, 'no-server', 'correct reason');
        t.equal(res.wrong[1].svname,
            '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
        t.equal(res.wrong[1].reason, 'no-server', 'correct reason');
        t.done();
    });
});

tap.test('app.checkStats addr-mismatch', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            'kind': 'webapi',
            'enabled': true,
            'address': '127.0.0.1'
        },
        '5c679a71-9ef7-4079-9a4c-45c9f5b97d45': {
            'kind': 'webapi',
            'enabled': true,
            'address': '127.0.0.2'
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            'kind': 'buckets-api',
            'enabled': true,
            'address': '127.0.0.1'
        }
    };

    haproxy_sock.serverStats({ log: log }, function (err, stats) {
        t.notOk(err);

        const res = app.checkStats(servers, stats);

        t.equal(res.reload, true, 'must reload');
        t.equal(res.wrong.length, 2, 'one addr-mismatch in 2 backends');
        t.equal(res.wrong[0].svname,
            '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
        t.equal(res.wrong[0].reason, 'addr-mismatch', 'correct reason');
        t.equal(res.wrong[1].svname,
            '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
        t.equal(res.wrong[1].reason, 'addr-mismatch', 'correct reason');
        t.done();
    });
});

tap.test('app.checkStats want-disabled', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            'kind': 'webapi',
            'enabled': true,
            'address': '127.0.0.1'
        },
        '5c679a71-9ef7-4079-9a4c-45c9f5b97d45': {
            'kind': 'webapi',
            'enabled': false,
            'address': '127.0.0.1'
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            'kind': 'buckets-api',
            'enabled': true,
            'address': '127.0.0.1'
        }
    };

    haproxy_sock.serverStats({ log: log }, function (err, stats) {
        t.notOk(err);

        const res = app.checkStats(servers, stats);

        t.equal(res.reload, false, 'must reload is false');
        t.equal(res.wrong.length, 2, 'one want-disabled in 2 backends');
        t.equal(res.wrong[0].svname,
            '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
        t.equal(res.wrong[0].reason, 'want-disabled', 'correct reason');
        t.equal(res.wrong[1].svname,
            '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
        t.equal(res.wrong[1].reason, 'want-disabled', 'correct reason');
        t.done();
    });
});

tap.test('app.checkStats want-enabled', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            'kind': 'webapi',
            'enabled': true,
            'address': '127.0.0.1'
        },
        '5c679a71-9ef7-4079-9a4c-45c9f5b97d45': {
            'kind': 'webapi',
            'enabled': false,
            'address': '127.0.0.1'
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            'kind': 'buckets-api',
            'enabled': true,
            'address': '127.0.0.1'
        }
    };

    haproxy_sock.syncServerState({ log: log, servers: servers },
      function (err) {
        t.notOk(err);

        servers['5c679a71-9ef7-4079-9a4c-45c9f5b97d45'].enabled = true;

        haproxy_sock.serverStats({ log: log }, function (err2, stats) {
            t.notOk(err2);

            const res = app.checkStats(servers, stats);

            t.equal(res.reload, false, 'must reload is false');
            t.equal(res.wrong.length, 2, 'one want-enabled in 2 backends');
            t.equal(res.wrong[0].svname,
                '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
            t.equal(res.wrong[0].reason, 'want-enabled', 'correct reason');
            t.equal(res.wrong[1].svname,
                '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781', 'correct svname');
            t.equal(res.wrong[1].reason, 'want-enabled', 'correct reason');
            t.done();
        });
    });
});
