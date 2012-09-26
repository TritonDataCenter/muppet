//  Copyright (c) 2012, Joyent, Inc. All rights reserved.

var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var sprintf = require('util').format;



///--- Globals

var CFG_FILE = path.resolve(__dirname, '../etc/haproxy.cfg');
var CFG_IN = fs.readFileSync(path.resolve(__dirname, '../etc/haproxy.cfg.in'),
                             'utf8');


///--- API

function updateConfig(hosts, callback) {
        var str = CFG_IN;
        hosts.forEach(function (h, i) {
                str += sprintf('        server be%d %s:80 check ' +
                               'slowstart 30s\n', i, h);
        });

        fs.writeFile(CFG_FILE, str, 'utf8', callback);
}


function restart(callback) {
        var tries = 0;

        function _restart() {
                exec('/usr/sbin/svcadm restart haproxy',
                     function (err, stdout, stderr) {
                             if (err) {
                                     if (++tries < 3)
                                             return (_restart());
                             }

                             return (callback(err));
                     });
        }

        _restart();
}



///--- Exports

module.exports = {

        restart: restart,
        updateConfig: updateConfig

};
