//  Copyright (c) 2012, Joyent, Inc. All rights reserved.

var exec = require('child_process').exec;
var fs = require('fs');
var os = require('os');
var path = require('path');
var sprintf = require('util').format;

var assert = require('assert-plus');
var backoff = require('backoff');



///--- Globals

var NICS = os.networkInterfaces();
var ADMIN_IP = Object.keys(NICS).filter(function (k) {
        var use = true;
        for (var i = 0; i < NICS[k].length; i++) {
                if (NICS[k][i].internal) {
                        use = false;
                        break;
                }
        }
        return (use);
}).map(function (k) {
        var addr;
        for (var i = 0; i < NICS[k].length; i++) {
                if (NICS[k][i].family === 'IPv4') {
                        addr = NICS[k][i].address;
                        break;
                }
        }
        return (addr || '127.0.0.1');
}).pop(); // TODO - handle internal and external NICs

var CFG_FILE = path.resolve(__dirname, '../etc/haproxy.cfg');
var CFG_IN = fs.readFileSync(path.resolve(__dirname, '../etc/haproxy.cfg.in'),
                             'utf8');
var RESTART = '/usr/sbin/svcadm restart haproxy';
var CLEAR_SERVER_LINE = '        server be%d %s:81 check slowstart 10s\n';
var SSL_SERVER_LINE =   '        server be%d %s:80 check slowstart 10s\n';



///--- API

function updateConfig(hosts, cb) {
        assert.arrayOfString(hosts, 'hosts');
        assert.func(cb, 'callback');

        var clear = '';
        var ssl = ''
        hosts.forEach(function (h, i) {
                clear += sprintf(CLEAR_SERVER_LINE, i, h);
                ssl += sprintf(SSL_SERVER_LINE, i, h);
        });

        var str = sprintf(CFG_IN, ssl, clear, ADMIN_IP);

        fs.writeFile(CFG_FILE, str, 'utf8', cb);
}


function restart(opts, cb) {
        assert.object(opts, 'options');
        assert.arrayOfString(opts.hosts, 'options.hosts');
        assert.object(opts.log, 'options.log');
        assert.optionalString(opts.restart, 'options.restart');
        assert.func(cb, 'callback');

        updateConfig(opts.hosts, function (err) {
                if (err) {
                        cb(err);
                        return;
                }

                var retry = backoff.call(exec, (opts.restart || RESTART), cb);
                retry.failAfter(3);
                retry.setStrategy(new backoff.ExponentialStrategy({
                        initialDelay: 1000
                }));
        });
}



///--- Exports

module.exports = {

        restart: restart

};
