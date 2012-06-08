//  Copyright (c) 2012, Joyent, Inc. All rights reserved.

var haproxy = require('./haproxy');
var Watch = require('./watch').Watch;



///--- Exports

module.exports = {

        createWatch: function createWatch(options) {
                return (new Watch(options));
        },

        restartHAProxy: haproxy.restart,
        updateHAProxyConfig: haproxy.updateConfig

};
