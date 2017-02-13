/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var exec = require('child_process').exec;
var fs = require('fs');
var os = require('os');
var path = require('path');
var sprintf = require('util').format;

var assert = require('assert-plus');
var once = require('once');
var backoff = require('backoff');



///--- Globals

var CFG_FILE = path.resolve(__dirname, '../etc/haproxy.cfg');
var CFG_IN = fs.readFileSync(path.resolve(__dirname, '../etc/haproxy.cfg.in'),
                             'utf8');
var RESTART = '/usr/sbin/svcadm restart haproxy';
/* JSSTYLED */
var CLEAR_SERVER_LINE = '        server be%d %s:81 check inter 30s slowstart 10s\n';
/* JSSTYLED */
var SSL_SERVER_LINE =   '        server be%d %s:80 check inter 30s slowstart 10s\n';
var BIND_LINE = '        bind %s:80\n';



///--- API

function updateConfig(opts, cb) {
    assert.string(opts.trustedIP, 'options.trustedIP');
    assert.arrayOfString(opts.untrustedIPs, 'options.untrustedIPs');
    assert.arrayOfString(opts.hosts, 'hosts');
    assert.func(cb, 'callback');

    cb = once(cb);

    var clear = '';
    var ssl = '';
    opts.hosts.forEach(function (h, i) {
        clear += sprintf(CLEAR_SERVER_LINE, i, h);
        ssl += sprintf(SSL_SERVER_LINE, i, h);
    });

    var untrusted = '';
    opts.untrustedIPs.forEach(function (ip) {
        untrusted += sprintf(BIND_LINE, ip);
    });

    var str = sprintf(CFG_IN,
        os.hostname(),
        ssl,
        clear,
        untrusted,
        opts.trustedIP,
        opts.trustedIP);

    fs.writeFile(CFG_FILE, str, 'utf8', cb);
}


/*
 * Regenerate the configuration file using the provided parameters, and then
 * restart HAProxy so that it picks it up.
 *
 * Options:
 * - trustedIP, an address on the Manta network that is considered preauthorized
 * - untrustedIPs, an array of addresses that untrusted traffic comes in over
 * - hosts, an array of Muskie backends to forward requests to
 * - restart (optional), the command to run to restart HAProxy
 * - log, a Bunyan logger
 */
function restart(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.trustedIP, 'options.trustedIP');
    assert.arrayOfString(opts.untrustedIPs, 'options.untrustedIPs');
    assert.arrayOfString(opts.hosts, 'options.hosts');
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.restart, 'options.restart');
    assert.func(cb, 'callback');

    cb = once(cb);

    updateConfig(opts, function (err) {
        if (err) {
            cb(err);
            return;
        }

        var retry = backoff.call(exec, (opts.restart || RESTART), cb);
        retry.failAfter(3);
        retry.setStrategy(new backoff.ExponentialStrategy({
            initialDelay: 1000
        }));
        retry.start();
    });
}



///--- Exports

module.exports = {

    restart: restart

};
