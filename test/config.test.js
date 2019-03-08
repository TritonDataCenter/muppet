/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */
var vasync = require('vasync');
var helper = require('./helper.js');
var lbm = require('../lib/lb_manager.js');
var path = require('path');
var fs = require('fs');
var jsdiff = require('diff');

///--- Globals
var test = helper.test;
var log = helper.createLogger();

// The good file to test against
var haproxy_good = path.resolve(__dirname, 'haproxy.cfg.good');

// Files that have a bad config in some way
var haproxy_no_listener = path.resolve(__dirname, 'haproxy.cfg.no-listener');
var haproxy_empty_error = path.resolve(__dirname, 'haproxy.cfg.empty');
var haproxy_parse_error = path.resolve(__dirname, 'haproxy.cfg.parse-error');
var haproxy_no_frontend = path.resolve(__dirname, 'haproxy.cfg.no-frontend');

// Input file to use for writeHaproxyConfig and restart
var haproxy_config_in = fs.readFileSync(path.resolve(__dirname,
                                                     'haproxy.cfg.in'),
                                        'utf8');

// File for writeHaproxyConfig to write out
var updConfig_out = path.resolve(__dirname, 'haproxy.cfg.out');
// File for the above to check against
var updConfig_out_chk = path.resolve(__dirname, 'haproxy.cfg.out-check');

// Files that the successful restart test will write out
var haproxy_file = path.resolve(__dirname, '../etc/haproxy.cfg');
var haproxy_file_tmp = path.resolve(__dirname, '../etc/haproxy.cfg.tmp');



///--- Tests

test('test good config file', function (t) {
    var opts = { log: helper.createLogger(),
        configFileOut: haproxy_good};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.equal(null, err);
        t.done();
    });
});

test('test no-listener config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        configFileOut: haproxy_no_listener};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

test('test empty config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        configFileOut: haproxy_empty_error};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

test('test parse error config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        configFileOut: haproxy_parse_error};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

test('test no-frontend config file (should error)', function (t) {
    var opts = { log: helper.createLogger(),
        configFileOut: haproxy_no_frontend};
    lbm.checkHaproxyConfig(opts, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

test('test get haproxy exec path', function (t) {
    var opts = { log: helper.createLogger() };
    lbm.getHaproxyExec(opts, function (err, data) {
        t.equal(null, err);
        t.notEqual(null, data);
        t.done();
    });
});

test('test writeHaproxyConfig', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        hosts: ['foo.joyent.us', 'bar.joyent.us'],
        configFileOut: updConfig_out,
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
                if (! part.value.includes('log-send-hostname')) {
                    t.equal(null, part.value);
                }
            }
        });
        fs.unlinkSync(updConfig_out);
        t.done();
    });
});

test('test writeHaproxyConfig bad config (should error)', function (t) {
    // haproxy shouldn't like empty hosts (no listen or backend)
    var opts = {
        trustedIP: '',
        untrustedIPs: [],
        hosts: [],
        configFileOut: updConfig_out,
        configFileIn: haproxy_config_in,
        log: helper.createLogger()
    };

    vasync.pipeline({ arg: opts, funcs: [
        lbm.writeHaproxyConfig,
        lbm.checkHaproxyConfig
    ]}, function (err) {
        t.notEqual(null, err);
        t.done();
    });
});

test('test restart', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        // This must resolve, so pick something public
        hosts: ['google.com'],
        restart: '/bin/true',
        configFileIn: haproxy_config_in,
        log: helper.createLogger()
    };

    lbm.restart(opts, function (err, data) {
        t.equal(null, err);
        t.doesNotThrow(function () {
            // Check if restart created the proper file
            // this will throw if the file doesn't exist
            fs.statSync(haproxy_file);
            // remove files that a successful restart
            // would have created
            fs.unlinkSync(haproxy_file);
        });
        t.done();
    });
});

test('test restart bad config (should error)', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        hosts: [],
        restart: '/bin/true',
        configFileIn: haproxy_config_in,
        log: helper.createLogger()
    };

    lbm.restart(opts, function (err, data) {
        t.notEqual(null, err);
        t.done();
    });
});

test('test dueling restarts', function (t) {
    var opts = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        hosts: ['google.com', 'joyent.com'],
        restart: '/bin/sleep 2',
        configFileIn: haproxy_config_in,
        log: helper.createLogger()
    };

    var opts2 = {
        trustedIP: '127.0.0.1',
        untrustedIPs: ['::1', '255.255.255.255'],
        // This must resolve, so pick something public
        hosts: ['google.com'],
        restart: '/bin/true',
        configFileIn: haproxy_config_in,
        log: helper.createLogger()
    };

    // Restart twice, calling the functions as fast as possible
    // Using a /bin/sleep call to make sure the first one is still
    // busy for the second call.
    lbm.restart(opts, function (err, data) {
        t.equal(null, err);
    });

    lbm.restart(opts2, function (err, data) {
        t.equal(null, err);
        t.done();
    });
});
