/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

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

tap.test('haproxy_sock.serverStats', function (t) {
    haproxy_sock.serverStats({log: log}, function (err, stats) {
        t.notOk(err);

        stats.forEach(function (srv) {
            t.match(srv.pxname, /buckets_api|insecure_api|secure_api/,
                'pxname is valid');
            t.match(srv.addr, /127\.0\.0\.1:[0-9]{4}/, 'addr is valid');
            t.equal(srv.act, '1', 'act is 1');
            // no server behind these, so DOWN
            t.equal(srv.status, 'DOWN', 'status is DOWN');
        });

        t.done();
    });
});

tap.test('haproxy_sock.syncServerState 1', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            kind: 'webapi',
            enabled: true
        },
        '5c679a71-9ef7-4079-9a4c-45c9f5b97d45': {
            kind: 'webapi',
            enabled: true
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            kind: 'buckets-api',
            enabled: 'true'
        }
    };

    haproxy_sock.syncServerState({ log: log, servers: servers },
      function (err) {
        t.notOk(err);

        haproxy_sock.serverStats({log: log}, function (err2, stats) {
            t.notOk(err2);

            stats.forEach(function (srv) {
                t.match(srv.pxname, /buckets_api|insecure_api|secure_api/,
                    'pxname is valid');
                t.match(srv.addr, /127\.0\.0\.1:[0-9]{4}/, 'addr is valid');
                t.equal(srv.act, '1', 'act is 1');
                // no server behind these, so DOWN
                t.equal(srv.status, 'DOWN', 'status is DOWN');
            });

            t.done();
        });
    });
});

tap.test('haproxy_sock.syncServerState 2', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            kind: 'webapi',
            enabled: true
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            kind: 'buckets-api',
            enabled: 'true'
        }
        // intentionally missing
        // '5c679a71-9ef7-4079-9a4c-45c9f5b97d45'
    };

    haproxy_sock.syncServerState({ log: log, servers: servers },
      function (err) {
        t.match(err.message,
            /unmapped server:.*\/5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781/,
            'correct error message');
        t.done();
    });
});

tap.test('haproxy_sock.syncServerState 3', function (t) {
    const servers = {
        '4afa9ff4-d918-42ed-9972-9ac20b7cf869': {
            kind: 'webapi',
            enabled: true
        },
        '5c679a71-9ef7-4079-9a4c-45c9f5b97d45': {
            kind: 'webapi',
            enabled: false
        },
        'cdf37eb6-090a-4e68-8282-90e99c6bb04d': {
            kind: 'buckets-api',
            enabled: false
        }
    };

    haproxy_sock.syncServerState({ log: log, servers: servers },
      function (err) {
        t.notOk(err);

        haproxy_sock.serverStats({log: log}, function (err2, stats) {
            t.notOk(err2);

            stats.forEach(function (srv) {
                t.match(srv.pxname, /buckets_api|insecure_api|secure_api/,
                    'pxname is valid');
                t.match(srv.addr, /127\.0\.0\.1:[0-9]{4}/, 'addr is valid');
                t.equal(srv.act, '1', 'act is 1');

                switch (srv.svname) {
                case '4afa9ff4-d918-42ed-9972-9ac20b7cf869:6780':
                    // no server behind these, so DOWN
                    t.equal(srv.status, 'DOWN', 'status is DOWN');
                    break;

                case 'cdf37eb6-090a-4e68-8282-90e99c6bb04d:8081':
                case '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781':
                    t.equal(srv.status, 'MAINT', 'status is MAINT');
                    break;

                default:
                    t.ok(false, 'unknown server ' + srv.svname);
                    break;
                }
            });

            reEnableServer(t, servers);
        });
    });
});

function reEnableServer(t, servers) {
    servers['5c679a71-9ef7-4079-9a4c-45c9f5b97d45'].enabled = true;

    haproxy_sock.syncServerState({ log: log, servers: servers },
      function (err) {
        t.notOk(err);

        haproxy_sock.serverStats({log: log}, function (err2, stats) {
            t.notOk(err2);

            stats.forEach(function (srv) {
                t.match(srv.pxname, /buckets_api|insecure_api|secure_api/,
                    'pxname is valid');
                t.match(srv.addr, /127\.0\.0\.1:[0-9]{4}/, 'addr is valid');
                t.equal(srv.act, '1', 'act is 1');
                switch (srv.svname) {
                case '4afa9ff4-d918-42ed-9972-9ac20b7cf869:6780':
                    // no server behind these, so DOWN
                    t.equal(srv.status, 'DOWN', 'status is DOWN');
                    break;

                case 'cdf37eb6-090a-4e68-8282-90e99c6bb04d:8081':
                    t.equal(srv.status, 'MAINT', 'status is MAINT');
                    break;

                case '5c679a71-9ef7-4079-9a4c-45c9f5b97d45:6781':
                    // after re-enabling a L4-failed server, we can get 'UP...'
                    // for a while, or 'DOWN'
                    t.match(srv.status, /UP.*|DOWN/,
                        'srv.status is wrong: ' + srv.status);
                    break;

                default:
                    t.ok(false, 'unknown server ' + srv.svname);
                    break;
                }
            });

            t.done();
        });
    });
}
