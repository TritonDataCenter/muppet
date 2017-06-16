// Copyright 2012 Mark Cavage.  All rights reserved.
//
// Just a simple wrapper over nodeunit's exports syntax. Also exposes
// a common logger for all tests.
//

var bunyan = require('bunyan');
var vasync = require('vasync');
var zkplus = require('zkplus');

var core = require('../lib');



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
        var host = process.env.ZK_HOST || 'localhost';
        var log = createLogger();
        var port = process.env.ZK_PORT || 2181;

        var zk = zkplus.createClient({
                log: log,
                servers: [ {
                        host: host,
                        port: port
                } ],
                timeout: 100
        });

        zk.once('error', function (err) {
                zk.removeAllListeners('connect');
                callback(err);
        });

        zk.once('connect', function () {
                zk.removeAllListeners('error');
                callback(null, zk);
        });
        zk.connect();
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
