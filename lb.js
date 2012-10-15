// Copyright (c) 2012, Joyent, Inc. All rights reserved.

var cluster = require('cluster');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var getopt = require('posix-getopt');
var proxy_protocol = require('proxy-protocol');
var restify = require('restify');
var uuid = require('node-uuid');

var buckets = require('./deps/buckets');



///--- Globals

var sprintf = util.format;

var ARGV;
var CFG;
var GATEWAY_ERROR =
        '504 Gateway Timeout\r\n' +
        'Connection: close\r\n' +
        'Date: %s\r\n' +
        'Server: Manta\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 0\r\n' +
        'x-request-id: %s\r\n' +
        'x-server-name: ' + os.hostname() + '\r\n' +
        '\r\n';

var LOAD_FACTOR =  Math.pow(2,16) - 1;
var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'muppet-lb',
        stream: process.stdout,
        serializers: {
                err: bunyan.stdSerializers.err,
                client_req: restify.bunyan.serializers.client_req,
                client_res: restify.bunyan.serializers.client_res,
                remote: function (c) {
                        var obj;

                        if (c.srca) {
                                var ip = net.isIPv6(c.srca) ?
                                        c.srca.split(':').pop() :
                                        c.srca;
                                obj = {
                                        address: ip,
                                        family: 'IPv4',
                                        port: c.srcp
                                };
                        } else if (c.remoteAddress) {
                                obj = {
                                        address: c.remoteAddress,
                                        family: 'IPv4',
                                        port: c.remotePort
                                };
                        } else if (c._peername) {
                                obj = {
                                        address: c._peername.address,
                                        family: 'IPv4',
                                        port: 'closed',
                                        remotePort: c._peername.port
                                };
                        } else {
                                obj = null;
                        }

                        return (obj);
                },
                table: function (t) {
                        var obj = [];
                        t.inorderTraversal(function (host) {
                                obj.push({
                                        ip: host.ip,
                                        load: host.load
                                });
                        });
                        return (obj);
                },
                upstream: function (c) {
                        var obj;
                        if (c.remoteAddress) {
                                obj = {
                                        address: c.remoteAddress,
                                        family: 'IPv4',
                                        port: c.address().port,
                                        remotePort: c.remotePort
                                };
                        } else if (c._peername) {
                                obj = {
                                        address: c._peername.address,
                                        family: 'IPv4',
                                        port: 'closed',
                                        remotePort: c._peername.port
                                };
                        } else {
                                obj = null;
                        }

                        return (obj);
                }
        }
});

var TABLE = new buckets.BSTree(function sort(a, b) {
        if (a.load < b.load) {
                return (-1);
        } else if (a.load > b.load) {
                return (1);
        } else if (a.ip < b.ip) {
                return (-1);
        } else if (a.ip > b.ip) {
                return (1);
        }

        return (0);
});



///--- Internal Functions

function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('svf:(file)', process.argv);

        while ((option = parser.getopt()) !== undefined) {
                switch (option.option) {
                case 'f':
                        opts.file = option.optarg;
                        break;

                case 's':
                        opts.single = true;
                        break;

                case 'v':
                        // Allows us to set -vvv -> this little hackery
                        // just ensures that we're never < TRACE
                        LOG.level(Math.max(bunyan.TRACE, (LOG.level() - 10)));
                        if (LOG.level() <= bunyan.DEBUG)
                                LOG = LOG.child({src: true});
                        break;

                default:
                        console.error('invalid option: ' + option.option);
                        process.exit(1);
                        break;
                }
        }

        ARGV = opts;
        return (opts);
}


function pauseStream(stream) {
        function _buffer(chunk) {
                stream.__buffered.push(chunk);
        }

        function _catchEnd(chunk) {
                stream.__lb_ended = true;
        }

        stream.__lb_ended = false;
        stream.__lb_paused = true;
        stream.__buffered = [];
        stream.on('data', _buffer);
        stream.once('end', _catchEnd);
        stream.pause();

        stream._resume = stream.resume;
        stream.resume = function _resume() {
                if (!stream.__lb_paused)
                        return;

                stream.removeListener('data', _buffer);
                stream.removeListener('end', _catchEnd);

                stream.__lb_paused = false;
                stream.__buffered.forEach(stream.emit.bind(stream, 'data'));
                stream.__buffered.length = 0;

                stream._resume();
                stream.resume = stream._resume;

                if (stream.__lb_ended)
                        stream.emit('end');
        };
}


function readConfig(opts) {
        if (!CFG) {
                CFG = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
                LOG.info({cfg: CFG}, '%s loaded', opts.file);
                CFG.upstream.servers.forEach(function (ip) {
                        LOG.debug({ip: ip}, 'adding host to router');
                        TABLE.add({
                                failures: 0,
                                ip: ip,
                                load: 0
                        });
                });
        }

        return (CFG);
}



///--- Load Balancer

function healthCheck(host) {
        var HEALTH_CFG = CFG.upstream.healthCheck;

        if (LOG.debug())
                LOG.debug(host,  '%s health check starting', host.ip);

        var client = restify.createClient({
                agent: false,
                connectTimeout: CFG.upstream.connectTimeout,
                log: LOG.child({component: 'health-check'}, true),
                url: 'http://' + host.ip + ':80',
        });
        var done = false;
        var ip = host.ip;
        var timer = setTimeout(fail, HEALTH_CFG.timeout);

        function fail(err) {
                if (done)
                        return;

                done = true;
                host.failures++;
                LOG.warn({
                        err: err,
                        host: host
                }, '%s health check failed', ip);

                if (host.failures === HEALTH_CFG.maxFailures) {
                        LOG.error(host, '%s marking as failed', ip);

                        TABLE.remove(host);
                        host.load += LOAD_FACTOR;
                        TABLE.add(host);
                }
        }

        client.get('/ping', function (err) {
                clearTimeout(timer);

                if (err) {
                        fail();
                } else {
                        if (host.failures >= HEALTH_CFG.maxFailures) {
                                LOG.info(host, 'clearing %s', host.ip);

                                TABLE.remove(host);
                                host.load -= LOAD_FACTOR;
                                TABLE.add(host);
                        }
                        host.failures = 0;

                        if (LOG.debug())
                                LOG.debug(host, '%s health check ok', ip);
                }

                setTimeout(healthCheck.bind(null, host), HEALTH_CFG.interval);
        });
}


function createProxySocket(conn, secure, cb) {
        var host = TABLE.minimum();
        if (!host) {
                cb(new Error('no upstream servers'));
                return;
        }

        TABLE.remove(host);
        host.load++
        TABLE.add(host);

        var done = false;
        var socket;
        var t;

        if (LOG.debug()) {
                LOG.debug({
                        host: host,
                        table: TABLE
                }, 'upstream selected');
        }

        function onConnectionClose() {
                if (LOG.trace()) {
                        LOG.trace({
                                remote: conn,
                                upstream: socket
                        }, 'remote socket closed');
                }

                // conn.removeListener('error', onError);
        }

        function onError(which, err) {
                if (LOG.debug()) {
                        LOG.debug({
                                err: err,
                                remote: conn,
                                upstream: socket,
                        }, '%s error encountered', which);
                }

                conn.removeListener('end', onConnectionClose);
                conn.removeListener('error', onError);
                socket.removeListener('error', onError);

                conn.destroy();
                socket.destroy();

                TABLE.remove(host);
                host.load--;
                TABLE.add(host);
        }

        conn.once('end', onConnectionClose);
        conn.once('error', onError.bind(null, 'remote'));

        function onConnect() {
                clearTimeout(t);
                socket.removeListener('error', onConnectError);
                socket.once('error', onError.bind(null, 'upstream'));

                if (LOG.trace()) {
                        LOG.trace({
                                remote: conn,
                                upstream: socket
                        }, 'connected to upstream');
                }

                if (CFG.frontend.idleTimeout) {
                        conn.setTimeout(CFG.frontend.idleTimeout, function () {
                                if (LOG.debug()) {
                                        LOG.debug({
                                                remote: conn,
                                                upstream: socket
                                        }, 'client idle timeout');
                                }

                                // Simply closing the client will let
                                // everything else flow
                                conn.end();
                        });
                }

                conn.pipe(socket);
                socket.pipe(conn);

                if (conn.__lb_paused)
                        conn.resume();

                cb(null, socket);
        }

        function onConnectError(err) {
                if (LOG.debug()) {
                        LOG.debug({
                                err: err,
                                remote: conn,
                                upstream: socket
                        }, 'client connection error');
                }

                TABLE.remove(host);
                host.load--;
                TABLE.add(host);

                cb(err);
        }

        function onSocketClose() {
                if (LOG.trace()) {
                        LOG.trace({
                                remote: conn,
                                upstream: socket
                        }, 'upstream socket closed');
                }

                TABLE.remove(host);
                host.load--;
                TABLE.add(host);

                socket.removeListener('error', onError);
        }

        socket = net.createConnection({
                host: host.ip,
                port: secure ? CFG.upstream.port : CFG.upstream.insecurePort
        });

        socket.once('connect', onConnect);
        socket.once('end', onSocketClose);
        socket.once('error', onConnectError);

        if (CFG.upstream.connectTimeout) {
                t = setTimeout(function () {
                        socket.emit('error', new Error('connect timeout'));
                }, CFG.upstream.connectTimeout);
        }
}


function passThrough(c) {
        pauseStream(c);

        if (LOG.trace())
                LOG.trace({remote: c}, 'clear proxy request received');

        createProxySocket(c, false, function (err, sock) {
                if (err) {
                        LOG.error(err, 'unable to proxy (clear)');
                        send504Error(c);
                        return;
                }

                LOG.info({
                        remote: c,
                        upstream: sock
                }, 'clear proxy');
        });
}


function proxy(c) {
        if (LOG.trace())
                LOG.trace({remote: c}, 'stud proxy request received');

        proxy_protocol.parse(c, function (err, obj) {
                if (err) {
                        LOG.error(err, 'unable to parse PROXY information');
                        c.destroy();
                        return;
                }

                pauseStream(c);

                LOG.debug(obj, 'PROXY protocol parsed');
                createProxySocket(c, true, function (err, sock) {
                        if (err) {
                                LOG.warn(err, 'unable to proxy (secure)');
                                send504Error(c);
                                return;
                        }

                        LOG.info({
                                remote: obj,
                                upstream: sock
                        }, 'secure proxy');
                });
        });
}


function send504Error(conn) {
        var msg = sprintf(GATEWAY_ERROR, restify.httpDate(), uuid.v4());
        conn.end(msg, 'utf8');
}


///--- Mainline

readConfig(parseOptions());

if (cluster.isMaster && !ARGV.single) {

        for (var i = 0; i < (CFG.numWorkers || 2); i++)
                cluster.fork();

} else {
        var HTTP = net.createServer(passThrough);
        HTTP.listen(CFG.frontend.port, function () {
                LOG.info('(clear) listening on %d', CFG.frontend.port);
        });

        var HTTPS = net.createServer(proxy);
        HTTPS.listen(CFG.frontend.studPort, '127.0.0.1', function () {
                LOG.info('(secure) listening on %d', CFG.frontend.studPort);
        });

        TABLE.inorderTraversal(function (host) {
                var rand = Math.floor(Math.random() * 1001);
                var wait = CFG.upstream.healthCheck.interval + rand;
                setTimeout(healthCheck.bind(null, host), wait);
        });

        process.on('uncaughtException', function (err) {
                // Node throws this up even though we've moved on, so sniff
                // and drop
                if (err.code === 'ECONNREFUSED' && err.syscall === 'connect') {
                        LOG.debug(err, 'uncaughtException: dropping');
                } else {
                        LOG.fatal(err, 'uncaughtException: exiting');
                        process.exit(1);
                }
        });
}
