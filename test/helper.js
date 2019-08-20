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

const bunyan = require('bunyan');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const haproxy_exec = path.resolve(__dirname, '../deps/haproxy/haproxy');
const haproxy_cfgfile = path.resolve(__dirname, './haproxy.cfg.test');
const haproxy_pidfile = '/tmp/haproxy.pid.test';
const haproxy_pemfile = '/tmp/haproxy.test.pem';

///--- Helpers

function createLogger(name, stream) {
    var log = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'warn'),
        name: name || process.argv[1],
        stream: stream || process.stdout,
        src: true,
        serializers: {
            err: bunyan.stdSerializers.err
        }
    });
    return (log);
}


function startHaproxy(cb) {
    child_process.execFile('/opt/local/bin/openssl', [ 'req', '-x509',
        '-nodes', '-days', '365', '-newkey', 'rsa:2048', '-keyout',
        haproxy_pemfile, '-out', haproxy_pemfile, '-subj',
        '/C=US/ST=CA/O=Joyent/OU=manta/CN=localhost' ],
      function (error, stdout, stderr) {
        if (error) {
            cb(error);
            return;
        }

        child_process.execFile(haproxy_exec, [ '-f', haproxy_cfgfile ],
          function (error2, stdout2, stderr2) {
            if (error2) {
                cb(error2);
                return;
            }

            // give some time for haproxy to start
            setTimeout(cb, 1000);
        });
    });
}

function killHaproxy(cb) {
    fs.readFile(haproxy_pidfile, function (err, haproxy_pid) {
        if (err) {
            cb(err);
            return;
        }

        process.kill(haproxy_pid);
        // give some time for haproxy to die
        setTimeout(cb, 1000);
    });
}

///--- Exports

module.exports = {
        createLogger: createLogger,
        startHaproxy: startHaproxy,
        killHaproxy: killHaproxy
};
