//  Copyright (c) 2012, Joyent, Inc. All rights reserved.

var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var sprintf = require('util').format;



///--- Globals

var CFG_FILE = path.resolve(__dirname, '../etc/loadbalancer.json');
var CFG_TMPL = path.resolve(__dirname, '../etc/loadbalancer.json.in');
var CFG_IN = JSON.parse(fs.readFileSync(CFG_TMPL, 'utf8'));



///--- API

function updateConfig(hosts, cb) {
        CFG_IN.upstream.servers = hosts.slice();

        fs.writeFile(CFG_FILE, JSON.stringify(CFG_IN, null, 8), 'utf8', cb);
}


function restart(callback) {
        var tries = 0;

        function _restart() {
                exec('/usr/sbin/svcadm restart manta/loadbalancer',
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
