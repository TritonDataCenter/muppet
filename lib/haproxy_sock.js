/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const FSM = require('mooremachine').FSM;
const lib_lbman = require('./lb_manager');
const mod_fs = require('fs');
const mod_assert = require('assert-plus');
const mod_forkexec = require('forkexec');
const mod_net = require('net');
const mod_util = require('util');
const mod_vasync = require('vasync');
const VError = require('verror');

/* These should be kept in sync with haproxy.cfg.in / haproxy.cfg.test */
const HAPROXY_SOCK_PATH = '/tmp/haproxy';
const HAPROXY_SOCK_PATH_TEST = '/tmp/haproxy.test';

const CONNECT_TIMEOUT = 3000;
const COMMAND_TIMEOUT = 30000;

/* Stats commands */
const HAPROXY_SERVER_STATS_COMMAND = 'show stat -1 4 -1';
const HAPROXY_ALL_STATS_COMMAND = 'show stat -1 7 -1';

function HaproxyCmdFSM(opts) {
    mod_assert.string(opts.command, 'opts.command');
    this.hcf_cmd = opts.command;

    mod_assert.object(opts.log, 'opts.log');
    this.hcf_log = opts.log;

    this.hcf_sockpath = process.env.MUPPET_TESTING === '1' ?
        HAPROXY_SOCK_PATH_TEST : HAPROXY_SOCK_PATH;

    this.hcf_sock = null;
    this.hcf_lastError = null;
    this.hcf_buf = '';

    FSM.call(this, 'connecting');
}
mod_util.inherits(HaproxyCmdFSM, FSM);

HaproxyCmdFSM.prototype.state_connecting = function (S) {
    var self = this;

    this.hcf_sock = mod_net.connect(self.hcf_sockpath);

    S.gotoStateOn(this.hcf_sock, 'connect', 'writing');
    S.on(this.hcf_sock, 'error', function (err) {
        self.hcf_lastError = new VError(err,
            'socket emitted error while connecting to %s',
            self.hcf_sockpath);
        S.gotoState('error');
    });
    S.timeout(CONNECT_TIMEOUT, function () {
        self.hcf_lastError = new VError(
            'timed out while connecting to %s',
            self.hcf_sockpath);
        S.gotoState('error');
    });
};

HaproxyCmdFSM.prototype.state_error = function (S) {
    var self = this;
    this.hcf_log.warn({ err: this.hcf_lastError, cmd: this.hcf_cmd },
        'haproxy command failed');
    S.immediate(function () {
        self.emit('error', self.hcf_lastError);
    });
};

HaproxyCmdFSM.prototype.state_writing = function (S) {
    this.hcf_log.trace({ cmd: this.hcf_cmd }, 'executing haproxy cmd');
    this.hcf_sock.write(this.hcf_cmd + '\n');
    this.hcf_sock.end();
    S.gotoState('reading');
};

HaproxyCmdFSM.prototype.state_reading = function (S) {
    var self = this;
    this.hcf_log.trace({ cmd: this.hcf_cmd }, 'waiting for results');
    S.on(this.hcf_sock, 'readable', function () {
        var chunk;
        while ((chunk = self.hcf_sock.read()) !== null) {
            self.hcf_buf += chunk.toString('ascii');
        }
    });
    S.on(this.hcf_sock, 'end', function () {
        S.gotoState('finished');
    });
    S.on(this.hcf_sock, 'error', function (err) {
        self.hcf_lastError = new VError(err,
            'socket emitted error while waiting for reply to command "%s"',
            self.hcf_cmd);
        S.gotoState('error');
    });
    S.timeout(COMMAND_TIMEOUT, function () {
        self.hcf_lastError = new VError(
            'timed out while executing command "%s"',
            self.hcf_cmd);
        S.gotoState('error');
    });
};

HaproxyCmdFSM.prototype.state_finished = function (S) {
    var self = this;
    this.hcf_log.trace({ cmd: this.hcf_cmd, result: this.hcf_buf },
        'command results received');
    S.immediate(function () {
        self.emit('result', self.hcf_buf);
    });
};

function disableServer(opts, cb) {
    mod_assert.object(opts, 'options');
    mod_assert.func(cb, 'callback');
    mod_assert.string(opts.backend, 'opts.backend');
    mod_assert.string(opts.server, 'opts.server');
    mod_assert.object(opts.log, 'opts.log');

    var fsm = new HaproxyCmdFSM({
        command: mod_util.format('disable server %s/%s',
            opts.backend, opts.server),
        log: opts.log
    });
    fsm.on('result', function (output) {
        if (/[^\s]/.test(output)) {
            cb(new VError('haproxy returned unexpected output: %j', output));
        } else {
            cb(null);
        }
    });
    fsm.on('error', function (err) {
        cb(err);
    });
}

function enableServer(opts, cb) {
    mod_assert.object(opts, 'options');
    mod_assert.func(cb, 'callback');
    mod_assert.string(opts.backend, 'opts.backend');
    mod_assert.string(opts.server, 'opts.server');
    mod_assert.object(opts.log, 'opts.log');

    var fsm = new HaproxyCmdFSM({
        command: mod_util.format('enable server %s/%s',
            opts.backend, opts.server),
        log: opts.log
    });
    fsm.on('result', function (output) {
        if (/[^\s]/.test(output)) {
            cb(new VError('haproxy returned unexpected output: %j', output));
        } else {
            cb(null);
        }
    });
    fsm.on('error', function (err) {
        cb(err);
    });
}

function disconnectServer(opts, cb) {
    mod_assert.object(opts, 'options');
    mod_assert.func(cb, 'callback');
    mod_assert.string(opts.backend, 'opts.backend');
    mod_assert.string(opts.server, 'opts.server');
    mod_assert.object(opts.log, 'opts.log');

    var fsm = new HaproxyCmdFSM({
        command: mod_util.format('shutdown sessions server %s/%s',
            opts.backend, opts.server),
        log: opts.log
    });
    fsm.on('result', function (output) {
        if (/[^\s]/.test(output)) {
            cb(new VError('haproxy returned unexpected output: %j', output));
        } else {
            cb(null);
        }
    });
    fsm.on('error', function (err) {
        cb(err);
    });
}

function serverStats(opts, cb) {
    statsCommon(opts, HAPROXY_SERVER_STATS_COMMAND, cb);
}
function allStats(opts, cb) {
    statsCommon(opts, HAPROXY_ALL_STATS_COMMAND, cb);
}

function statsCommon(opts, cmd, cb) {
    mod_assert.object(opts, 'options');
    mod_assert.string(cmd, 'cmd');
    mod_assert.func(cb, 'callback');
    mod_assert.object(opts.log, 'opts.log');

    var fsm = new HaproxyCmdFSM({
        command: cmd,
        log: opts.log
    });
    fsm.on('result', function (output) {

        /*
         * OS-8159 describes a bug deep in the STREAMS local transport provider
         * that results in us very occasionally getting a premature EOF.  If
         * this happens, we'll just try one more time.
         */
        if (output.length === 0 && !opts.retrying) {
            opts.retrying = true;
            opts.log.info('got empty reply from haproxy; retrying');
            statsCommon(opts, cmd, cb);
            return;
        }

        var lines = output.split('\n');
        if (!/^#/.test(lines[0])) {
            cb(new VError('haproxy returned unexpected output: %j', output));
            return;
        }
        var headings = lines[0].slice(2).split(',');
        var objs = [];
        lines.slice(1).forEach(function (line) {
            var parts = line.split(',');
            if (parts.length < headings.length)
                return;
            var obj = {};
            for (var i = 0; i < parts.length; ++i) {
                if (parts[i].length > 0)
                    obj[headings[i]] = parts[i];
            }
            objs.push(obj);
        });
        cb(null, objs);
    });
    fsm.on('error', function (err) {
        cb(err);
    });
}

/*
 * The "opt.servers" argument is an object where each key corresponds to the
 * 'svname' of an haproxy server name (<pxname/<svname>).
 *
 * See lib/lb_manager.js for an explanation of haproxy configuration.
 */
function syncServerState(opts, cb) {
    mod_assert.object(opts, 'options');
    mod_assert.func(cb, 'callback');
    mod_assert.object(opts.servers, 'opts.servers');
    mod_assert.object(opts.log, 'opts.log');

    var servers = opts.servers;

    serverStats({ log: opts.log }, function (err, stats) {
        var toDisable = [];
        var toEnable = [];

        if (err) {
            cb(new VError(err, 'unable to sync server state: stats command ' +
                'failed'));
            return;
        }

        stats.forEach(function (stat) {
            var server = lib_lbman.lookupSvname(servers, stat.svname);

            if (server === undefined) {
                /*
                 * haproxy config is probably out of sync with what we think it
                 * is. This is bad, and we should restart muppet and re-do
                 * everything.
                 */
                err = new VError('unmapped server: "%s/%s"', stat.pxname,
                    stat.svname);
                return;
            }

            if (!server.enabled && stat.status !== 'MAINT') {
                toDisable.push({
                    log: opts.log,
                    backend: stat.pxname,
                    server: stat.svname
                });
            } else if (server.enabled && stat.status === 'MAINT') {
                toEnable.push({
                    log: opts.log,
                    backend: stat.pxname,
                    server: stat.svname
                });
            }
        });

        if (err) {
            cb(err);
            return;
        }

        opts.log.debug({ disable: toDisable, enable: toEnable },
            'sync server state with haproxy');

        /*
         * We do a separate socket connection and command for each change we
         * need to make -- the alternative would be to concat them all together
         * with semicolons, which would then stop us from being able to tell
         * which command failed.
         */
        opts.enableState = mod_vasync.forEachPipeline({
            inputs: toEnable,
            func: enableServer
        }, function (err2) {
            if (err2) {
                cb(err2);
                return;
            }

            opts.disableState = mod_vasync.forEachPipeline({
                inputs: toDisable,
                func: disableServer
            }, function (err3) {
                if (err3) {
                    cb(err3);
                    return;
                }

                /*
                 * Kill the existing connections to the disabled servers right
                 * away. When we eventually have drain support in the backend
                 * servers, we won't need to do this.
                 */
                opts.killState = mod_vasync.forEachPipeline({
                    inputs: toDisable,
                    func: disconnectServer
                }, function (err4) {
                    if (err4) {
                        cb(err4);
                        return;
                    }
                    /* Don't include the logger in the results. */
                    toEnable.forEach(function (job) {
                        delete (job.log);
                    });
                    toDisable.forEach(function (job) {
                        delete (job.log);
                    });
                    cb(null, toEnable, toDisable);
                });
            });
        });
    });
}

/*
 * We need to serialize the execution of all the exported functions. This is
 * required because all these functions use haproxy socket which can't be
 * accessed concurrently.
 */

var queue = mod_vasync.queue(function (task, qcb) {
    mod_assert.object(task, 'task');
    mod_assert.func(task.func, 'task.func');
    mod_assert.object(task.opts, 'task.opts');
    mod_assert.func(task.cb, 'task.cb');

    task.func(task.opts, function _cb(err, data) {
        task.cb(err, data);
        qcb();
    });
}, 1);


// serialize a given function
function serialize(func) {
    return (function (opts, cb) {
        var task = {
            func: func,
            opts: opts,
            cb: cb
        };
        queue.push(task);
    });
}


module.exports = {
    /* Exported for testing */
    disableServer: serialize(disableServer),
    enableServer: serialize(enableServer),
    disconnectServer: serialize(disconnectServer),
    /* Used by app.js */
    serverStats: serialize(serverStats),
    syncServerState: serialize(syncServerState),
    /* Used by metric_exporter.js */
    allStats: serialize(allStats)
};
