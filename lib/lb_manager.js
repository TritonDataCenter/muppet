/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * This file manages regeneration of the haproxy configuration. Typically, we
 * do this on muppet startup, or when a new muskie server becomes available.
 *
 * We take the haproxy.cfg.in template and write out the new configuration,
 * replacing the frontend's bind IPs with the relevant IPs from SAPI.  For the
 * proxy backends, we need to generate output of the form:
 *
 * backend secure_api
 *  option httpchk GET /ping
 *  server <uuid>:80 <ip>:80 check inter 30s slowstart 10s
 *  server <uuid>:80 <ip>:80 check inter 30s slowstart 10s
 *  ...
 *
 * backend insecure_api
 *  option httpchk GET /ping
 *  server <uuid>:81 <ip>:81 check inter 30s slowstart 10s
 *  server <uuid>:81 <ip>:81 check inter 30s slowstart 10s
 *  ...
 *
 * where <uuid> is the muskie zone UUID, and <ip> is the relevant interface.
 *
 * In haproxy terminology, the "pxname" for the backend is the "secure_api"
 * part, and the "svname" for each server line is the '<uuid>:81' part. These
 * show up as keys in lib/haproxy_sock.js.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const execFile = require('child_process').execFile;
const exec = require('child_process').exec;
const fs = require('fs');
const os = require('os');
const path = require('path');
const sprintf = require('util').format;

const assert = require('assert-plus');
const once = require('once');
const vasync = require('vasync');
const jsprim = require('jsprim');

///--- Globals

const CFG_FILE = path.resolve(__dirname, '../etc/haproxy.cfg');
const CFG_FILE_TMP = path.resolve(__dirname, '../etc/haproxy.cfg.tmp');
const CFG_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, '../etc/haproxy.cfg.in'), 'utf8');
const HAPROXY_FMRI = 'svc:/manta/haproxy:default';
const RELOAD = '/usr/sbin/svcadm refresh ' + HAPROXY_FMRI;
const CLEAR_SERVER_LINE =
    '        server %s:81 %s:81 check inter 30s slowstart 10s\n';
const SSL_SERVER_LINE =
    '        server %s:80 %s:80 check inter 30s slowstart 10s\n';
const INSECURE_FRONTEND =
    'frontend http_external\n        default_backend insecure_api\n';
const INSECURE_BIND_LINE = '        bind %s:80\n';

var reload_queue = vasync.queue(function (f, cb) { f(cb); }, 1);

/*
 * Generate a haproxy configuration file using the provided parameters.
 *
 * Options:
 * - trustedIP, an address on the Manta network that is considered preauthorized
 * - untrustedIPs, an array of addresses that untrusted traffic comes in over
 * - servers, an array of Muskie backend servers to forward requests to
 * - configFile, the config file to write out
 * - configTemplate, the config template string
 * - log, a Bunyan logger
 */
function writeHaproxyConfig(opts, cb) {
    assert.string(opts.trustedIP, 'options.trustedIP');
    assert.arrayOfString(opts.untrustedIPs, 'options.untrustedIPs');
    assert.object(opts.servers, 'servers');
    assert.string(opts.configFile, 'options.configFile');
    assert.string(opts.configTemplate, 'options.configTemplate');
    assert.object(opts.log, 'options.log');
    assert.func(cb, 'callback');
    // For testing

    cb = once(cb);

    if (Object.keys(opts.servers).length === 0) {
        return (cb(new Error('Haproxy config error: No servers given')));
    }

    var clear = '';
    var ssl = '';

    for (var name in opts.servers) {
        clear += sprintf(CLEAR_SERVER_LINE, name, opts.servers[name].address);
        ssl += sprintf(SSL_SERVER_LINE, name, opts.servers[name].address);
    }

    var untrusted = '';
    if (opts.untrustedIPs.length > 0) {
        untrusted += INSECURE_FRONTEND;
        opts.untrustedIPs.forEach(function (ip) {
            untrusted += sprintf(INSECURE_BIND_LINE, ip);
        });
    }

    const str = sprintf(opts.configTemplate,
        os.hostname(),
        ssl,
        clear,
        untrusted,
        opts.trustedIP,
        opts.trustedIP);

    opts.log.debug('Writing haproxy config file: %s', opts.configFile);
    return (fs.writeFile(opts.configFile, str, 'utf8', cb));
}

/*
 * Note: this is just "fire and forget" of the opts.reload command (default
 * is `svcadm refresh`). Assumes that the full config validation code
 * has been run first, i.e. expected to be called as part of the
 * exported reload function.
 *
 * reload works by calling refresh which works like this:
 * - only the master process will take the signal
 * - it'll keep running, so SMF is happy
 * - master will start a new worker with the new config, and pass
 *   along the listening sockets
 * - a configured maximum number of old instances may hang around for
 *   already open connections
 */
function reloadHaproxy(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.reload, 'options.reload');

    const _reload = opts.reload || RELOAD;
    opts.log.debug('Reloading haproxy config with: %s...', _reload);

    exec(_reload, cb);
}

/*
 * Gets the haproxy executable path from  SMF.
 */
function getHaproxyExec(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.haproxyExec, 'opts.haproxyExec');
    assert.func(cb, 'callback');

    if (opts.haproxyExec !== undefined) {
        cb(null, opts.haproxyExec);
        return;
    }

    // svcprop returns something like:
    //    /opt/local/sbin/haproxy\ -f\ %{config_file}\ -D
    execFile('/usr/bin/svcprop', ['-p', 'start/exec', HAPROXY_FMRI ],
        function (error, stdout, _stderr) {
            var haproxy_exec = null;
            if (error !== null) {
                opts.log.error(error, 'failed to find haproxy exec path');
                return (cb(error));
            } else {
                // svcprop line returned, parse out the haproxy path
                const m = stdout.match(/(^.*?\/haproxy)\\{1}/);
                if (m !== null) {
                    haproxy_exec = m[1];
                } else {
                    opts.log.error('Error finding haproxy exec path in %s',
                                   stdout);
                    return (cb(new Error('Error finding haproxy exec path')));
                }
                opts.log.debug('Found haproxy exec path: %s', haproxy_exec);
                return (cb(null, haproxy_exec));
            }
        });
}

function checkHaproxyConfig(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.string(opts.configFile, 'options.configFile');

    vasync.waterfall([
        function getExec(wfcb) {
            getHaproxyExec(opts, wfcb); },
        function checkFunc(wfResult, wfcb) {
            execFile(wfResult, ['-f', opts.configFile, '-c'],
                function (error, stdout, _stderr) {
                    if (error !== null) {
                        return (wfcb(error));
                    }
                    opts.log.debug('haproxy: ' + stdout.trim());
                    return (wfcb(null));
                });
        }
    ], function (err) {
        if (err) {
            opts.log.error(err,
                'Error checking haproxy config file %s', opts.configFile);
            return (cb(err));
        }
        return (cb(null));
    });
}

///--- API

/*
 * Regenerate the configuration file using the provided parameters, and then
 * reload HAProxy configuration.
 *
 * Options:
 * - trustedIP, an address on the Manta network that is considered preauthorized
 * - untrustedIPs, an array of addresses that untrusted traffic comes in over
 * - servers, Muskie backend servers to forward requests to
 * - reload (optional), the command to run to reload HAProxy config
 * - configTemplate (optional), the haproxy config template
 * - log, a Bunyan logger
 */
function reload(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.trustedIP, 'options.trustedIP');
    assert.arrayOfString(opts.untrustedIPs, 'options.untrustedIPs');
    assert.object(opts.servers, 'options.servers');
    assert.object(opts.log, 'options.log');
    assert.func(cb, 'callback');
    // For testing
    assert.optionalString(opts.configTemplate, 'options.configTemplate');
    assert.optionalString(opts.reload, 'options.reload');

    opts.log.debug({servers: opts.servers}, 'reload requested');

    cb = once(cb);

    /*
     * Only one reload at a time, hence the queue.
     */
    reload_queue.push(function (queuecb) {

        opts.log.debug({servers: opts.servers}, 'reloading');

        /*
         * Kick off the reload pipeline.
         *
         * - Generate a temporary config file with writeHaproxyConfig.
         * - Check the temporary config with checkHaproxyConfig
         * - Rename temporary file to final file once check passes
         * - Tell haproxy to reload with the known-good config file
         */
        opts.configFile = CFG_FILE_TMP;

        if (opts.configTemplate === undefined) {
            opts.configTemplate = CFG_TEMPLATE;
        }

        vasync.pipeline({ arg: opts, funcs: [
            writeHaproxyConfig,
            checkHaproxyConfig,
            function finalRenameConfig(arg, callback) {
                arg.log.debug('Renaming haproxy config file: %s to %s',
                    arg.configFile, CFG_FILE);

                return (fs.rename(arg.configFile, CFG_FILE, callback));
            },
            function finalReload(arg, callback) {
                reloadHaproxy({log: arg.log, reload: arg.reload}, callback);
            }
        ]}, function (err) {
            opts.log.debug('reload complete');
            queuecb();
            if (err) {
                opts.log.error(err, 'Error reconfiguring haproxy');
                cb(err);
            } else {
                cb();
            }
        });
    });
}

function reloading() {
    return (reload_queue.npending > 0);
}

/*
 * servers is indexed by the bare zone UUID, whereas we populate the haproxy
 * config 'svname' with a :portnum suffix, as can be seen in CLEAR_SERVER_LINE
 * and SSL_SERVER_LINE.
 */
function lookupSvname(servers, svname) {
    return (servers[svname.split(':', 1)[0]]);
}

///--- Exports

module.exports = {
    reload: reload,
    reloading: reloading,
    lookupSvname: lookupSvname,
    // Below only exported for testing
    checkHaproxyConfig: checkHaproxyConfig,
    writeHaproxyConfig: writeHaproxyConfig
};
