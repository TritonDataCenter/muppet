//  Copyright (c) 2012, Joyent, Inc. All rights reserved.

var lbm = require('./lb_manager');
var Watch = require('./watch').Watch;
var zk = require('./zk');



///--- Exports

module.exports = {

        createWatch: function createWatch(options) {
                return (new Watch(options));
        },

        restartLB: lbm.restart,
        updateLBConfig: lbm.updateConfig,
        createZooKeeperClient: zk.createZooKeeperClient

};
