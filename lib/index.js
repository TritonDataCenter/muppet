/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

const lbm = require('./lb_manager');
const zkm = require('./zk.js');
const Watch = require('./watch').Watch;


///--- Exports
module.exports = {
    createWatch: function createWatch(options) {
        return (new Watch(options));
    },
    createZKClient: zkm.createZKClient,
    reloadLB: lbm.reload
};
