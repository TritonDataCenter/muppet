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

const mod_fs = require('fs');
const mod_assert = require('assert-plus');
const mod_forkexec = require('forkexec');
const mod_net = require('net');
const mod_util = require('util');
const mod_vasync = require('vasync');
const VError = require('verror').VError;
const FSM = require('mooremachine').FSM;

/* This should be kept in sync with haproxy.cfg.in */
const HAPROXY_SOCK_PATH = '/tmp/haproxy';

const CONNECT_TIMEOUT = 3000;
const COMMAND_TIMEOUT = 30000;

function HaproxyCmdFSM(opts) {
	mod_assert.string(opts.command, 'opts.command');
	this.hcf_cmd = opts.command;

	mod_assert.object(opts.log, 'opts.log');
	this.hcf_log = opts.log

	this.hcf_sock = null;
	this.hcf_lastError = null;
	this.hcf_buf = '';

	FSM.call(this, 'connecting');
}
mod_util.inherits(HaproxyCmdFSM, FSM);

HaproxyCmdFSM.prototype.state_connecting = function (S) {
	var self = this;

	this.hcf_sock = mod_net.connect(HAPROXY_SOCK_PATH);

	S.gotoStateOn(this.hcf_sock, 'connect', 'writing');
	S.on(this.hcf_sock, 'error', function (err) {
		self.hcf_lastError = new VError(err,
		    'socket emitted error while connecting to %s',
		    HAPROXY_SOCK_PATH);
		S.gotoState('error');
	});
	S.timeout(CONNECT_TIMEOUT, function () {
		self.hcf_lastError = new VError(
		    'timed out while connecting to %s',
		    HAPROXY_SOCK_PATH);
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
		    'socket emitted error while waiting for reply to ' +
		    'command "%s"', self.hcf_cmd);
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
			cb(new VError('haproxy returned unexpected ' +
			    'output: %j', output));
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
			cb(new VError('haproxy returned unexpected ' +
			    'output: %j', output));
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
			cb(new VError('haproxy returned unexpected ' +
			    'output: %j', output));
		} else {
			cb(null);
		}
	});
	fsm.on('error', function (err) {
		cb(err);
	});
}

function serverStats(opts, cb) {
	mod_assert.object(opts, 'options');
	mod_assert.func(cb, 'callback');
	mod_assert.object(opts.log, 'opts.log');

	var fsm = new HaproxyCmdFSM({
		command: 'show stat',
		log: opts.log
	});
	fsm.on('result', function (output) {
		var lines = output.split('\n');
		if (!/^#/.test(lines[0])) {
			cb(new VError('haproxy returned unexpected ' +
			    'output: %j', output));
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

function syncBackendState(opts, cb) {
	mod_assert.object(opts, 'options');
	mod_assert.func(cb, 'callback');
	mod_assert.object(opts.backends, 'opts.backends');
	mod_assert.object(opts.log, 'opts.log');

	var backends = opts.backends;

	serverStats({ log: opts.log }, function (err, stats) {
		var toDisable = [];
		var toEnable = [];

		stats.forEach(function (stat) {
			if (stat.svname === 'BACKEND' ||
			    stat.svname === 'FRONTEND')
				return;
			if (backends[stat.svname] === false &&
			    stat.status !== 'MAINT') {
				toDisable.push({
					log: opts.log,
					backend: stat.pxname,
					server: stat.svname
				});
			} else if (backends[stat.svname] === true &&
			    stat.status === 'MAINT') {
				toEnable.push({
					log: opts.log,
					backend: stat.pxname,
					server: stat.svname
				});
			} else if (backends[stat.svname] === undefined) {
				/*
				 * haproxy config is probably out of sync
				 * with what we think it is. This is bad, and
				 * we should restart muppet and re-do
				 * everything. Throwing will also leave a core
				 * to investigate later.
				 */
				throw (new VError('unmapped backend: "%s/%s"',
				    stat.pxname, stat.svname));
			}
		});

		opts.log.debug({ disable: toDisable, enable: toEnable },
		    'sync backend state with haproxy');

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

				opts.killState = mod_vasync.forEachPipeline({
					inputs: toDisable,
					func: disconnectServer
				}, function (err4) {
					if (err4) {
						cb(err4);
						return;
					}
					cb(null);
				});
			});
		});
	});
}

module.exports = {
	disableServer: disableServer,
	enableServer: enableServer,
	disconnectServer: disconnectServer,
	serverStats: serverStats,
	syncBackendState: syncBackendState,
};
