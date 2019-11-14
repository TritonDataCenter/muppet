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
 * do this on muppet startup, or when a new backend server becomes available.
 *
 * We take the haproxy.cfg.in template and write out the new configuration,
 * replacing the frontend's bind IPs with the relevant IPs from SAPI.  For the
 * proxy backends, we need to generate output of the form:
 *
 * backend buckets_api
 *  option httpchk GET /ping
 *  server <uuid>:8081 <ip>:8081 check inter 30s slowstart 10s
 *  server <uuid>:8082 <ip>:8082 check inter 30s slowstart 10s
 *  ...
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
 * where <uuid> is the zone UUID, and <ip> is the relevant interface.
 *
 * In haproxy terminology, the "pxname" for the backend is the "buckets_api"
 * part, and the "svname" for each server line is the '<uuid>:8081' part. These
 * show up as keys in lib/haproxy_sock.js.
 *
 * The frontends route to the appropriate backend as needed; in particular, all
 * buckets traffic matches a URI of "/:login/buckets" and is re-routed to
 * the buckets_api backend. Legacy (muskie/webapi) traffic goes to secure_api or
 * insecure_api as necessary.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const bunyan = require('bunyan');
const execFile = require('child_process').execFile;
const exec = require('child_process').exec;
const fs = require('fs');
const os = require('os');
const path = require('path');
const sprintf = require('sprintf-js').sprintf;

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

const HTTP_FRONTEND =
    'frontend http_external\n        default_backend insecure_api\n';
const HTTP_BIND_LINE = '        bind %s:80\n';

var reload_queue = vasync.queue(function (f, cb) { f(cb); }, 1);

/*
 * Generate a haproxy configuration file using the provided parameters.
 *
 * Options:
 * - trustedIP, an address on the Manta network that is considered preauthorized
 * - untrustedIPs, an array of addresses that external traffic comes in over
 * - servers, an array of backend server addresses to forward requests to
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

    /*
     * Our log format is fixed, but the necessary escaping would make it close
     * to impossible to read - and comment on - so we do it here.
     *
     * We're purposefully similar to the log entries of the API servers, partly
     * for the benefit of the bunyan CLI parsing.
     *
     * This is the least ugly way I could figure out to generate the correct
     * line, which needs to escape double quotes, but only when the field is
     * a string.
     */
    const logFormat = '\"' + JSON.stringify({
        msg: 'handled: %ST',
        req: {
            method: '%HM',
            url: 1,
            headers: {
                'x-request-id': '%[capture.req.hdr(0)]'
            }
        },
        res: {
            statusCode: 2
        },
        timers: {
            req: 3,
            queued: 4,
            server_conn: 5,
            res: 6,
            total: 7
        },
        client_ip: '%ci',
        client_port: 8,
        time: '%tr',
        frontend: '%ft',
        backend: '%b',
        server: '%s',
        retries: 9,
        res_bytes_read: 10,
        termination_state: '%tsc',
        pid: 11,
        hostname: os.hostname(),
        name: 'haproxy',
        level: bunyan.INFO,
        v: 0
    })
        // JSSTYLED
        .replace(/1,/, '%{+Q}HU,')
        .replace(/2/, '%ST')
        .replace(/3/, '%TR')
        .replace(/4/, '%Tw')
        .replace(/5/, '%Tc')
        .replace(/6/, '%Tr')
        .replace(/7/, '%Ta')
        .replace(/8/, '%cp')
        .replace(/9/, '%rc')
        .replace(/10/, '%B')
        .replace(/11/, '%pid')
        // JSSTYLED
        .replace(/"/g, '\\"') + '\"';

    var sslWebapiServers = '';
    var clearWebapiServers = '';
    var bucketsServers = '';

    for (var name in opts.servers) {
        const sstr =
            '        server %s:%s %s:%s check inter 30s slowstart 10s\n';
        if (opts.servers[name].kind === 'buckets-api') {
            opts.servers[name].ports.forEach(function (port) {
                bucketsServers += sprintf(sstr, name, port,
                    opts.servers[name].address, port);
            });
        } else {
            sslWebapiServers += sprintf(sstr, name, '80',
                opts.servers[name].address, '80');
            clearWebapiServers += sprintf(sstr, name, '81',
                opts.servers[name].address, '81');
        }
    }

    var externalFrontends = '';
    if (opts.untrustedIPs.length > 0) {
        externalFrontends += HTTP_FRONTEND;
        opts.untrustedIPs.forEach(function (ip) {
            externalFrontends += sprintf(HTTP_BIND_LINE, ip);
        });
    }

    const str = sprintf(opts.configTemplate, {
        'hostname': os.hostname(),
        'log_format': logFormat,
        'bucket_servers': bucketsServers,
        'webapi_secure_servers': sslWebapiServers,
        'webapi_insecure_servers': clearWebapiServers,
        'insecure_frontend': externalFrontends,
        'trusted_ip': opts.trustedIP
        });

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
 * - untrustedIPs, an array of addresses that external traffic comes in over
 * - servers, backend server addresses to forward requests to
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
 * config 'svname' with a :portnum suffix.
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
