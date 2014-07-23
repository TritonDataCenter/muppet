//  Copyright (c) 2013, Joyent, Inc. All rights reserved.

var exec = require('child_process').exec;
var fs = require('fs');
var os = require('os');
var path = require('path');
var sprintf = require('util').format;

var assert = require('assert-plus');
var once = require('once');
var backoff = require('backoff');



///--- Globals

var CFG_FILE = path.resolve(__dirname, '../etc/haproxy.cfg');
var CFG_IN = fs.readFileSync(path.resolve(__dirname, '../etc/haproxy.cfg.in'),
                             'utf8');
var TCP_DEF = fs.readFileSync(path.resolve(__dirname,
                              '../etc/haproxy.cfg.tcp-defaults'), 'utf8');
var RESTART = '/usr/sbin/svcadm restart haproxy';
var FRONTEND = 'frontend %s\n' +
               '        bind %s:%d\n' +
               '        default_backend %s\n';
var HTTP_BACKEND = 'backend %s\n' +
                   '        option httpchk GET /ping\n';
var HTTP_HOST_FRONTEND = 'frontend %s\n' +
                         '        bind %s:80\n';
var HTTPS_FRONTEND = 'frontend %s\n' +
                     '        bind 127.0.0.1:8443 accept-proxy\n' +
                     '        default_backend %s';
var NO_TCP_DEFAULTS = '# <No TCP services configured - omitting TCP defaults>';
var NOT_CONF = '# <Not configured>';
var TCP_BACKEND = 'backend %s\n';
/* JSSTYLED */
var CLEAR_SERVER_LINE = '        server be%d %s:81 check inter 30s slowstart 10s\n';
/* JSSTYLED */
var SSL_SERVER_LINE =   '        server be%d %s:80 check inter 30s slowstart 10s\n';
/* JSSTYLED */
var TCP_SERVER_LINE =   '        server be%d %s:%d check inter 30s slowstart 10s\n';
var HEADER_LINES = '        acl is_%s hdr(host) -i %s\n' +
                   '        use_backend %s if is_%s\n';



///--- Private Functions

function strOrNotConf(str) {
    if (str.length === 0)
        return (NOT_CONF);

    return (str);
}



///--- API

function updateConfig(opts, cb) {
    assert.string(opts.adminIp, 'options.adminIp');
    assert.optionalString(opts.externalIp, 'options.exernalIp');
    assert.arrayOfObject(opts.hosts, 'options.hosts');
    assert.func(cb, 'callback');

    cb = once(cb);

    // External HTTP backend / frontend
    var extHttpBE = '';
    var extHttpFE = '';
    // External HTTPS backend / frontend
    var extHttpsBE = '';
    var extHttpsFE = '';
    // Internal HTTP backends / frontends
    var intHttpBE = '';
    var intHttpFE = '';
    // TCP defaults
    var tcpDef = '';
    // TCP backends / frontends
    var intTcpBE = '';
    var intTcpFE = '';

    opts.hosts.forEach(function (host) {
        if (host.external) {
            if (host.https) {
                extHttpsBE = sprintf(HTTP_BACKEND, 'secure_api');
                extHttpsFE = sprintf(HTTPS_FRONTEND, 'https', 'secure_api');
            }

            if (host.http) {
                if (opts.hasOwnProperty('externalIp')) {
                    extHttpBE = sprintf(HTTP_BACKEND, 'insecure_api');
                    extHttpFE = sprintf(FRONTEND, 'http_external',
                        opts.externalIp, 80, 'insecure_api');
                } else {
                    opts.log.warn(
                        'external HTTP service configured but no external IP');
                }
            }

            if (host.internalHttp) {
                intHttpFE = sprintf(FRONTEND, 'http_internal',
                    opts.adminIp, 80, 'secure_api');
            }

            host.hosts.forEach(function (h, i) {
                if (host.http) {
                    extHttpBE += sprintf(CLEAR_SERVER_LINE, i, h);
                }

                if (host.https) {
                    extHttpsBE += sprintf(SSL_SERVER_LINE, i, h);
                }
            });

            return;
        }

        var backendName;
        var name = host.domain.split('.')[0];

        if (host.tcpPorts && host.tcpPorts.length !== 0) {
            if (tcpDef.length === 0)
                tcpDef = TCP_DEF;

            if (intTcpBE.length !== 0)
                intTcpBE += '\n';

            host.tcpPorts.forEach(function (port) {
                backendName = name + '_' + port + '_be';
                intTcpFE += sprintf(FRONTEND, name + '_' + port,
                    opts.adminIp, port, backendName);
                intTcpBE += sprintf(TCP_BACKEND, backendName);

                host.hosts.forEach(function (h, i) {
                    intTcpBE += sprintf(TCP_SERVER_LINE, i, h, port);
                });
            });
        }

        if (host.http) {
            backendName = name + '_http';
            if (intHttpFE.length === 0)
                intHttpFE = sprintf(HTTP_HOST_FRONTEND, 'http_internal',
                    opts.adminIp);

            if (intHttpBE.length !== 0)
                intHttpBE += '\n';

            intHttpFE += sprintf(HEADER_LINES, name, host.domain, backendName,
                name);
            intHttpBE += sprintf(HTTP_BACKEND, backendName);

            host.hosts.forEach(function (h, i) {
                intHttpBE += sprintf(SSL_SERVER_LINE, i, h);
            });
        }
    });

    var str = sprintf(CFG_IN,
                      os.hostname(),
                      strOrNotConf(extHttpsBE),
                      strOrNotConf(extHttpBE),
                      strOrNotConf(intHttpBE),
                      strOrNotConf(extHttpsFE),
                      strOrNotConf(extHttpFE),
                      strOrNotConf(intHttpFE),
                      opts.adminIp,
                      tcpDef.length === 0 ? NO_TCP_DEFAULTS : tcpDef,
                      strOrNotConf(intTcpBE),
                      strOrNotConf(intTcpFE));

    fs.writeFile(CFG_FILE, str, 'utf8', cb);
}


function restart(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.adminIp, 'options.adminIp');
    assert.optionalString(opts.externalIp, 'options.externalIp');
    assert.arrayOfObject(opts.hosts, 'options.hosts');
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.restart, 'options.restart');
    assert.func(cb, 'callback');

    cb = once(cb);

    opts.log.info({
        changed: opts.changed,
        hosts: opts.hosts
    }, 'restarting lb');

    updateConfig(opts, function (err) {
        if (err) {
            cb(err);
            return;
        }

        var retry = backoff.call(exec, (opts.restart || RESTART), cb);
        retry.failAfter(3);
        retry.setStrategy(new backoff.ExponentialStrategy({
            initialDelay: 1000
        }));
        retry.start();
    });
}



///--- Exports

module.exports = {

    restart: restart

};
