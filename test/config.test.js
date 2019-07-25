/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */
var fs = require('fs');
var helper = require('./helper.js');
var jsdiff = require('diff');
var lbm = require('../lib/lb_manager.js');
var path = require('path');
var tap = require('tap');
var vasync = require('vasync');

///--- Globals
var log = helper.createLogger();

// Files that have a bad config in some way
var haproxy_no_listener = path.resolve(__dirname, 'haproxy.cfg.no-listener');
var haproxy_empty_error = path.resolve(__dirname, 'haproxy.cfg.empty');
var haproxy_parse_error = path.resolve(__dirname, 'haproxy.cfg.parse-error');

// File for writeHaproxyConfig to write out
var updConfig_out = path.resolve(__dirname, 'haproxy.cfg.out');
// File for the above to check against
var updConfig_out_chk = path.resolve(__dirname, 'haproxy.cfg.out-check');

// Template string
const haproxy_template = fs.readFileSync(
    path.resolve(__dirname, 'haproxy.cfg.in'), 'utf8');

// Files that the successful reload test will write out
var haproxy_file = path.resolve(__dirname, '../etc/haproxy.cfg');
var haproxy_file_tmp = path.resolve(__dirname, '../etc/haproxy.cfg.tmp');

var haproxy_exec = path.resolve(__dirname, '../build/haproxy/sbin/haproxy');


///--- Tests

tap.test('test good config file', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFile: updConfig_out_chk};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.equal(null, err);
        t.done();
    });
});

tap.test('test no-listener config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFile: haproxy_no_listener};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.ok(err);
        t.done();
    });
});

tap.test('test empty config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFile: haproxy_empty_error};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.ok(err);
        t.done();
    });
});

tap.test('test parse error config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        haproxyExec: haproxy_exec,
        configFile: haproxy_parse_error};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.ok(err);
        t.done();
    });
});

tap.test('test writeHaproxyConfig', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: {
            'foo.joyent.us': {
                kind: 'webapi',
                address: '127.0.0.1'
            },
            'bar.joyent.us': {
                kind: 'webapi',
                address: '127.0.0.2'
            },
            'baz.joyent.us': {
                kind: 'buckets-api',
                address: '127.0.0.3',
                ports: [ '8081', '8082', '8083', '8084' ]
            }
        },
        configFile: updConfig_out,
        haproxyExec: haproxy_exec,
        configTemplate: haproxy_template,
        log: helper.createLogger()
    };
    lbm.writeHaproxyConfig(opts, function (err, data) {
        t.equal(null, err);
        var test_txt = fs.readFileSync(updConfig_out, 'utf8');
        var check_txt = fs.readFileSync(updConfig_out_chk, 'utf8');

        var diff = jsdiff.diffTrimmedLines(test_txt, check_txt);

        diff.forEach(function (part) {
            if (part.added) {
                if (! part.value.includes('log-send-hostname')) {
                    t.equal(null, part.value);
                }
            } else if (part.removed) {
                if ((! part.value.includes('log-send-hostname')) &&
                    // the input cfg is commented
                    (! part.value.startsWith('#'))) {
                    t.equal(null, part.value);
                }
            }
        });
        fs.unlinkSync(updConfig_out);
        t.done();
    });
});

tap.test('test writeHaproxyConfig bad config (should error)', function (t) {
    // haproxy shouldn't like empty servers
    var opts = {
        trustedIP: '',
        untrustedIPs: [],
        servers: {},
        configFile: updConfig_out,
        haproxyExec: haproxy_exec,
        configTemplate: haproxy_template,
        log: helper.createLogger()
    };

    vasync.pipeline({ arg: opts, funcs: [
        lbm.writeHaproxyConfig,
        lbm.checkHaproxyConfig
    ]}, function (err) {
        t.ok(err);
        t.done();
    });
});

tap.test('test reload', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: { 'foo.joyent.us': { address: '127.0.0.1' } },
        reload: '/bin/true',
        haproxyExec: haproxy_exec,
        configTemplate: haproxy_template,
        log: helper.createLogger()
    };

    lbm.reload(opts, function (err, data) {
        t.equal(undefined, err);
        t.doesNotThrow(function () {
            // Check if reload created the proper file
            // this will throw if the file doesn't exist
            fs.statSync(haproxy_file);
            // remove files that a successful reload
            // would have created
            fs.unlinkSync(haproxy_file);
        });
        t.done();
    });
});

tap.test('test reload bad config (should error)', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: {},
        reload: '/bin/true',
        haproxyExec: haproxy_exec,
        configTemplate: haproxy_template,
        log: helper.createLogger()
    };

    lbm.reload(opts, function (err, data) {
        t.ok(err);
        t.done();
    });
});

/*
 * The first reload is slower due to the sleep, but the serialization should
 * still invoke its callback first.
 */
tap.test('test dueling reloads', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: {
            'foo.joyent.us': { kind: 'webapi', address: '127.0.0.1' },
            'bar.joyent.us': { kind: 'webapi', address: '127.0.0.1' }
        },
        reload: '/bin/sleep 2',
        haproxyExec: haproxy_exec,
        configTemplate: haproxy_template,
        log: helper.createLogger()
    };

    var opts2 = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        servers: { 'foo.joyent.us': { kind: 'webapi', address: '127.0.0.1' } },
        reload: '/bin/true',
        haproxyExec: haproxy_exec,
        configTemplate: haproxy_template,
        log: helper.createLogger()
    };

    var first = false;
    var second = false;

    lbm.reload(opts, function (err, data) {
        first = true;
        t.notOk(second, 'second should be false');
        t.equal(undefined, err);
    });

    lbm.reload(opts2, function (err, data) {
        t.equal(undefined, err);
        second = true;
        t.ok(first, 'first should be true');
        t.done();
    });
});
