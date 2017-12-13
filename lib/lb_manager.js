/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
const backoff = require('backoff');
const vasync = require('vasync');
const jsprim = require('jsprim');



///--- Globals

const CFG_FILE = path.resolve(__dirname, '../etc/haproxy.cfg');
const CFG_FILE_TMP = path.resolve(__dirname, '../etc/haproxy.cfg.tmp');
const CFG_IN = fs.readFileSync(path.resolve(__dirname, '../etc/haproxy.cfg.in'),
                             'utf8');
const RESTART = '/usr/sbin/svcadm restart haproxy';
/* JSSTYLED */
const CLEAR_SERVER_LINE = '        server be%d %s:81 check inter 30s slowstart 10s\n';
/* JSSTYLED */
const SSL_SERVER_LINE =   '        server be%d %s:80 check inter 30s slowstart 10s\n';
const INSECURE_FRONTEND =
    'frontend http_external\n        default_backend insecure_api\n';
const INSECURE_BIND_LINE = '        bind %s:80\n';

// Locks for single reset run
var RESTART_RUNNING = false;
var RESTART_NEEDS_RUN = false;

// Storage for objects we might lose if we block on a restart lock
var RESTART_OPTS = {};
var RESTART_CB = null;

/*
 * Generate a haproxy configuration file using the provided parameters
 *
 * Options:
 * - trustedIP, an address on the Manta network that is considered preauthorized
 * - untrustedIPs, an array of addresses that untrusted traffic comes in over
 * - hosts, an array of Muskie backends to forward requests to
 * - configFileOut (optional), the config file to write out
 * - log, a Bunyan logger
 */
function writeHaproxyConfig(opts, cb) {
    assert.string(opts.trustedIP, 'options.trustedIP');
    assert.arrayOfString(opts.untrustedIPs, 'options.untrustedIPs');
    assert.arrayOfString(opts.hosts, 'hosts');
    assert.optionalString(opts.configFileOut, 'options.configFileOut');
    assert.object(opts.log, 'options.log');
    assert.func(cb, 'callback');
    // For testing
    assert.optionalString(opts.configFileIn, 'options.configFileIn');

    cb = once(cb);

    var clear = '';
    var ssl = '';
    // Fail fast if there are no backend hosts given
    if (opts.hosts.length > 0) {
        opts.hosts.forEach(function (h, i) {
            clear += sprintf(CLEAR_SERVER_LINE, i, h);
            ssl += sprintf(SSL_SERVER_LINE, i, h);
        });
    } else {
        return (cb(new Error('Haproxy config error: No hosts given')));
    }

    var untrusted = '';
    if (opts.untrustedIPs.length > 0) {
        untrusted += INSECURE_FRONTEND;
        opts.untrustedIPs.forEach(function (ip) {
            untrusted += sprintf(INSECURE_BIND_LINE, ip);
        });
    }

    const _cfg_in = opts.configFileIn || CFG_IN;
    const str = sprintf(_cfg_in,
        os.hostname(),
        ssl,
        clear,
        untrusted,
        opts.trustedIP,
        opts.trustedIP);

    const configOut = opts.configFileOut || CFG_FILE;
    opts.log.debug('Writing haproxy config file: %s', configOut);
    return (fs.writeFile(configOut, str, 'utf8', cb));
}


function restartHaproxy(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.restart, 'options.restart');

    const _restart = opts.restart || RESTART;
    opts.log.debug('Restarting haproxy with: %s...', _restart);

    const retry = backoff.call(exec, _restart, cb);
    retry.failAfter(3);
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: 1000
    }));
    retry.on('backoff', function (number, delay, err) {
        opts.log.debug({
            attempt: number,
            delay: delay,
            err: err
        }, 'Haproxy restart attempted');
    });
    retry.start();
}

/*
 * Gets the haproxy executable path that is used in SMF so that
 * we aren't hard-coding the haproxy path in two separate spots
 *
 */
function getHaproxyExec(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.func(cb, 'callback');
    // svcprop returns something like:
    //    /opt/local/sbin/haproxy\ -f\ %{config_file}\ -D
    execFile('/usr/bin/svcprop', ['-p', 'start/exec', 'haproxy' ],
        function (error, stdout, _stderr) {
            var haproxy_exec = null;
            if (error !== null) {
                opts.log.error(error, 'failed to find haproxy exec path');
                return (cb(error));
            } else {
                // svccfg line returned, parse out the haproxy path
                const m = stdout.match(/[\w/]+haproxy/);
                if (m !== null) {
                    haproxy_exec = m[0];
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

/*
 * Renames a configuration file
 * The intention is to be used to rename
 * the temporary known-good file into a
 * final config file for haproxy.
 *
 * Options:
 * - configFileIn (optional), the config file to rename
 * - configFileOut (optional), the target file name
 * - log, a Bunyan logger
 */
function renameHaproxyConfig(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.configFileIn, 'options.configFileIn');
    assert.optionalString(opts.configFileOut, 'options.configFileOut');

    // Use default file names if not provided
    const configIn = opts.configFileIn || CFG_FILE_TMP;
    const configOut = opts.configFileOut || CFG_FILE;

    opts.log.debug('Renaming haproxy config file: %s to %s',
        configIn, configOut);

    return (fs.rename(configIn, configOut, cb));
}

/*
 * Checks if a haproxy config file is valid
 *
 * Options:
 * - configFileOut (optional), the config file to test
 * - log, a Bunyan logger
 */
function checkHaproxyConfig(opts, cb) {
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.configFileOut, 'options.configFileOut');

    const configOut = opts.configFileOut || CFG_FILE;

    vasync.waterfall([
        function getExec(wfcb) {
            getHaproxyExec(opts, wfcb); },
        function checkFunc(wfResult, wfcb) {
            execFile(wfResult, ['-f', configOut, '-c'],
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
                'Error checking haproxy config file %s', configOut);
            return (cb(err));
        }
        return (cb(null));
    });
}

///--- API

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
    assert.func(cb, 'callback');
    // For testing
    assert.optionalString(opts.restart, 'options.restart');
    assert.optionalString(opts.configFileIn, 'options.configFileIn');

    /*
     * Wrap restart logic in a cheap & simple lock to ensure we are not writing
     * a new temp config file while renaming the temp config file in a previous
     * restart cycle. In addition, save the options from the queued restart().
     * If the most diabolical timing issue happened where multiple restart()'s
     * got queued, we'd only care about at most two (the current,
     * and the last one queued).
     */
    /*
     * TODO: If a third restart() call happened, and a delay
     * happened to the first and second call, the second call's
     * callback would get lost since we only save/restore the
     * one queued restart. This will be filed in a separate
     * issue. This issue however is an extremely unlikely event
     * considering the speed in which we get ZK notifications.
     */
    if (RESTART_RUNNING) {
        opts.log.debug('Restart is already running, queueing restart...');
        opts.log.debug('Hosts we are saving for queued restart: %s',
            opts.hosts);
        RESTART_OPTS = jsprim.deepCopy(opts);
        RESTART_CB = jsprim.deepCopy(cb);
        RESTART_NEEDS_RUN = true;
        return;
    }
    RESTART_RUNNING = true;

    cb = once(cb);

    /*
     * Kick off the checkConfig -> writeHaproxyConfig ->
     *   restartHaproxy pipeline
     * - Generate a temporary config file with writeHaproxyConfig.
     * - Check the temporary config with checkHaproxyConfig
     * - Rename temporary file to final file once check passes
     * - Restart haproxy with a known-good config file
     */
    var tmpOpts = jsprim.deepCopy(opts);
    tmpOpts.configFileOut = CFG_FILE_TMP;

    vasync.pipeline({ arg: tmpOpts, funcs: [
        writeHaproxyConfig,
        checkHaproxyConfig,
        function finalRenameConfig(_, callback) {
            renameHaproxyConfig({log: opts.log}, callback); },
        function finalRestart(_, callback) {
            restartHaproxy(opts, callback); }
    ]}, function (err) {
        if (err) {
            opts.log.error(err, 'Error reconfiguring haproxy');
            cb(err);
        } else {
            cb(null);
        }

        // Clear the lock now that we are finished
        RESTART_RUNNING = false;
        // Call a restart if one is pending
        if (RESTART_NEEDS_RUN) {
            RESTART_NEEDS_RUN = false;
            opts.log.debug('Calling queued restart, using saved hosts: %s',
                          RESTART_OPTS.hosts);
            restart(RESTART_OPTS, RESTART_CB);
        }
    });
}



///--- Exports

module.exports = {
    restart: restart,
    // Below only exported for testing
    checkHaproxyConfig: checkHaproxyConfig,
    writeHaproxyConfig: writeHaproxyConfig,
    getHaproxyExec: getHaproxyExec
};
