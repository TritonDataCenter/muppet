/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const EventEmitter = require('events').EventEmitter;
const util = require('util');
const assert = require('assert-plus');
const once = require('once');
const vasync = require('vasync');
const jsprim = require('jsprim');


///--- Globals

const sprintf = util.format;

///--- Private Functions

// Turns something like manta.machine.joyent.com into com/joyent/machine/manta
function domainToPath(domain) {
    return ('/' + domain.split('.').reverse().join('/'));
}


///--- API
function Watch(options) {
    assert.object(options);
    assert.string(options.domain);
    assert.object(options.log);
    assert.object(options.zk);

    EventEmitter.call(this);

    this.hosts = [];
    this.log = options.log.child({clazz: 'Watch'}, true);
    this.path = domainToPath(options.domain);
    this.zk = options.zk;
}
util.inherits(Watch, EventEmitter);

Watch.prototype.start = function start(callback) {
    callback = once(callback);

    const log = this.log;
    const zk = this.zk;
    var self = this;
    var tasks = [];

    log.debug({
        path: self.path
    }, 'start: entered');

    /*
     * Setup tasks we need to accomplish on start
     *  mkdirp - for ensuring the path in ZK exists
     *  watch - for creating the ZK watcher on the above path
     *  setup - for setting up watchers for hosts being added/removed/changed
     *          in the above ZK path
     */
    tasks.push(function mkdirp(_, cb) {
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'mkdirp: ensuring directory exists');
        const nullBuffer = new Buffer('null', 'ascii');
        zk.createWithEmptyParents(self.path, nullBuffer, {}, function (err) {
            if (err && err.code === 'NODE_EXISTS') {
                log.debug({
                    path: self.path
                }, 'mkdirp: directory already exists');
                cb(null);
            } else if (err) {
                cb(err);
            } else {
                log.debug({
                    path: self.path
                }, 'mkdirp: directory created');
                cb(null);
            }
        });
    });

    tasks.push(function watch(_, cb) {
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'watch: creating watcher');

        self.watcher = zk.watcher(self.path);
        cb(null);
    });

    tasks.push(function setup(_, cb) {
        assert.object(self.watcher);
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'setup: registering hooks');

        self.watcher.on('error', function onWatchError(watchErr) {
            log.error({
                err: watchErr,
                path: self.path
            }, 'onWatchError: error from ZooKeeper');
            self.emit('error', watchErr);
        });

        self.watcher.on('childrenChanged', function onChildren(children) {
            log.debug({
                path: self.path,
                children: children
            }, 'onChildrenChanged: watch fired');

            /*
             * Children are returned as a list of UUID's like:
             *  children: [
             *    "26ec0faf-740e-4b55-be1a-XXXX",
             *    "a6a58d04-0099-4319-83dc-XXXX"
             *  ]
             *
             * This function then fetches the object at the path
             * corresponding to this entry, determining if it is a
             * host we care about.
             */
            function getChild(child, _cb) {
                const p = self.path + '/' + child;
                // Get info about host out of ZK
                zk.get(p, function (err, _obj) {
                    // Object returned as binary data from get()
                    const obj = JSON.parse(_obj.toString());
                    if (err) {
                        _cb(err);
                    } else if (obj.type !== 'host') {
                        /*
                         * webapi and loadbalancer instances both register
                         * themselves into the same domain, but as different
                         * types ("host" and "load_balancer", respectively).
                         * Here we effectively filter out anything but webapi
                         * instances.
                         */
                        _cb(null);
                    } else {
                        log.debug({
                            path: self.path,
                            host: obj
                        }, 'onChildrenChanged::getChild: host fetched');
                        _cb(null, obj.host.address);
                    }
                });
            }

            /*
             * Process children array in parallel, calling getChild() on each
             * entry
             */
            const opts = {
                func: getChild,
                inputs: children
            };
            vasync.forEachParallel(opts, function (err, res) {
                if (err) {
                    log.error({
                        path: self.path,
                        err: err
                    }, 'onChildrenChanged: get host information failed');
                    self.emit('error', err);
                } else {
                    var hosts = [];
                    /*
                     * This little snippet just drops
                     * nulls and duplicates
                     */
                    res.successes.forEach(function uniqHost(h) {
                        if (h && (hosts.indexOf(h) < 0)) {
                            hosts.push(h);
                        }
                    });
                    hosts.sort();

                    /*
                     * Only emit if the set of webapi instances has
                     * changed.
                     */
                    if (!jsprim.deepEqual(hosts, self.hosts)) {
                        // Log the changes first
                        log.debug({
                            path: self.path,
                            current: self.hosts,
                            new: hosts
                        }, 'onChildrenChanged: hosts differ, changing');
                        self.hosts = hosts;
                        log.info({
                            path: self.path,
                            hosts: self.hosts
                        }, 'onChildrenChanged: hosts updated');
                        // Emit updated hosts list
                        self.emit('hosts', self.hosts);
                    } else {
                        log.info({
                            path: self.path,
                            current: self.hosts
                        }, 'onChildrenChanged: got hosts, but no changes');
                    }
                }
            });
        });
        cb(null);
    });

    // Kick off the mkdirp -> watch -> register pipeline
    vasync.pipeline({ funcs: tasks }, function (err) {
        if (err) {
            log.error({
                path: self.path,
                err: err
            }, 'Watch start: ZK error');
            if (typeof (callback) === 'function') {
                callback(err);
            } else {
                self.emit('error', err);
            }
        } else {
            log.debug({
                path: self.path
            }, 'start: watching successful');

            if (typeof (callback) === 'function')
                callback(null);

            process.nextTick(function () {
                self.emit('start');
            });
        }
    });
};

Watch.prototype.stop = function stop() {
    if (this.watcher) {
        // Call EventEmitter::removeAllListeners to stop watching
        this.watcher.removeAllListeners('childrenChanged');
    }
};

Watch.prototype.toString = function toString() {
    var str = '[object Watch <';
    str += sprintf('path=%s,', (this.path || 'null'));
    str += sprintf('hosts=%j', (this.hosts || []));
    str += '>]';
    return (str);
};


///--- Exports

module.exports = {
    Watch: Watch
};
