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
var RESTART = '/usr/sbin/svcadm restart haproxy';
/* JSSTYLED */
var CLEAR_SERVER_LINE = '        server be%d %s:81 check inter 30s slowstart 10s\n';
/* JSSTYLED */
var SSL_SERVER_LINE =   '        server be%d %s:80 check inter 30s slowstart 10s\n';



///--- API

function updateConfig(opts, cb) {
    assert.string(opts.adminIp, 'options.adminIp');
    assert.string(opts.externalIp, 'options.exernalIp');
    assert.arrayOfString(opts.hosts, 'hosts');
    assert.func(cb, 'callback');

    cb = once(cb);

    var clear = '';
    var ssl = '';
    opts.hosts.forEach(function (h, i) {
        clear += sprintf(CLEAR_SERVER_LINE, i, h);
        ssl += sprintf(SSL_SERVER_LINE, i, h);
    });

    var str = sprintf(CFG_IN,
                      os.hostname(),
                      ssl,
                      clear,
                      opts.externalIp,
                      opts.adminIp,
                      opts.adminIp);

    fs.writeFile(CFG_FILE, str, 'utf8', cb);
}


function restart(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.adminIp, 'options.adminIp');
    assert.string(opts.externalIp, 'options.externalIp');
    assert.arrayOfString(opts.hosts, 'options.hosts');
    assert.object(opts.log, 'options.log');
    assert.optionalString(opts.restart, 'options.restart');
    assert.func(cb, 'callback');

    cb = once(cb);

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
