/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * JSLint has a problem with 'use strict', but we want it on so
 * const fails if reassignment is attempted. With strict off, const
 * reassignments are silently dropped on the floor
 */
/*jsl:ignore*/
'use strict';
/*jsl:end*/

const mod_fs = require('fs');
const mod_assert = require('assert-plus');
const mod_bunyan = require('bunyan');
const mod_dashdash = require('dashdash');
const mod_forkexec = require('forkexec');
const mod_net = require('net');
const VError = require('verror');

const lib_app = require('./lib/app');
const lib_lbman = require('./lib/lb_manager');

///--- CLI Functions

function configure() {
    const cli_options = [
        {
            names: ['help', 'h'],
            type: 'bool',
            help: 'Print this help and exit.'
        },
        {
            names: ['verbose', 'v'],
            type: 'arrayOfBool',
            help: 'Verbose output. Use multiple times for more verbose.'
        },
        {
            names: ['file', 'f'],
            type: 'string',
            help: 'File to process',
            helpArg: 'FILE'
        },
        {
            names: ['metricsPort', 'm'],
            type: 'number',
            help: 'Metrics port',
            helpArg: 'PORT'
        }
    ];

    const parser = new mod_dashdash.Parser({options: cli_options});
    var log = mod_bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'muppet',
        stream: process.stdout,
        serializers: {
            err: mod_bunyan.stdSerializers.err
        }
    });

    var opts;
    try {
        opts = parser.parse(process.argv);
        mod_assert.object(opts, 'options');
    } catch (e) {
        log.fatal(e, 'invalid options');
        process.exit(1);
    }

    if (opts.help) {
        usage();
    }

    var cfg;
    try {
        const _f = opts.file || __dirname + '/etc/config.json';
        cfg = JSON.parse(mod_fs.readFileSync(_f, 'utf8'));
        if (cfg.adminIPS && typeof (cfg.adminIPS) === 'string') {
            cfg.adminIPS = cfg.adminIPS.split(',');
        }
        if (cfg.mantaIPS && typeof (cfg.mantaIPS) === 'string') {
            cfg.mantaIPS = cfg.mantaIPS.split(',');
        }
    } catch (e) {
        log.fatal(e, 'unable to parse %s', _f);
        process.exit(1);
    }

    mod_assert.string(cfg.domain, 'cfg.domain');
    mod_assert.string(cfg.trustedIP, 'cfg.trustedIP');
    mod_assert.object(cfg.zookeeper, 'cfg.zookeeper');
    mod_assert.number(cfg.haproxy.nbthread, 'cfg.haproxy.nbthread');
    mod_assert.optionalArrayOfString(cfg.untrustedIPs, 'cfg.untrustedIPs');

    if (cfg.logLevel)
        log.level(cfg.logLevel);

    if (opts.metricsPort) {
        if (isNaN(opts.metricsPort)) {
            log.fatal('invalid metrics port specified: %s', opts.metricsPort);
            process.exit(1);
        }

        cfg.metricsPort = parseInt(opts.metricsPort, 10);
    }

    if (opts.verbose) {
        opts.verbose.forEach(function () {
            log.level(Math.max(mod_bunyan.TRACE, (log.level() - 10)));
        });
    }

    if (log.level() <= mod_bunyan.DEBUG)
        log = log.child({src: true});

    cfg.log = log;
    cfg.zookeeper.log = log;

    return (cfg);
}


function usage(msg) {
    if (msg)
        console.error(msg);

    var str = 'usage: ' + require('path').basename(process.argv[1]);
    str += '[-v] [-f file]';
    console.error(str);
    process.exit(msg ? 1 : 0);
}


///--- Mainline

var config = configure();
var app = new lib_app.AppFSM(config);
