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

const bunyan = require('bunyan');
const vasync = require('vasync');
const zkstream = require('zkstream');

const core = require('../lib');



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


function createZkClient(callback) {
        const host = process.env.ZK_HOST || 'localhost';
        var log = createLogger();
        const port = process.env.ZK_PORT || 2181;

        core.createZKClient({
                log: log,
                servers: [ {
                        address: host,
                        port: port
                } ],
                timeout: 100
        }, function (_err, zk) {
            zk.on('failed', function (err) {
                callback(err);
            });
            zk.on('session', function () {
                callback(null, zk);
            });
        });
}



///--- Exports

module.exports = {

        after: function after(teardown) {
                module.parent.exports.tearDown = function _teardown(callback) {
                        try {
                                teardown.call(this, callback);
                        } catch (e) {
                                console.error('after:\n' + e.stack);
                                process.exit(1);
                        }
                };
        },

        before: function before(setup) {
                module.parent.exports.setUp = function _setup(callback) {
                        try {
                                setup.call(this, callback);
                        } catch (e) {
                                console.error('before:\n' + e.stack);
                                process.exit(1);
                        }
                };
        },

        test: function test(name, tester) {
                module.parent.exports[name] = function _(t) {
                        var _done = false;
                        t.end = function end() {
                                if (!_done) {
                                        _done = true;
                                        t.done();
                                }
                        };
                        t.notOk = function notOk(ok, message) {
                                return (t.ok(!ok, message));
                        };

                        tester(t);
                };
        },

        createLogger: createLogger,
        createZkClient: createZkClient

};
