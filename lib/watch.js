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
const verror = require('verror');
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
                    if (err) {
                        err.path = p;
                        _cb(err);
                    } else {
                        var obj;
                        if (_obj instanceof Buffer) {
                            // Object returned as binary data from get()
                            obj = JSON.parse(_obj.toString());
                        } else if (_obj instanceof Object) {
                            // We have seen Object data returned from zk.get via
                            // this callback in MANTA-4064. This code is to help
                            // gain understanding into what that data is.
                            log.info({
                                path: self.path,
                                obj: JSON.stringify(_obj)},
                                'onChildrenChanged::getChild: received an ' +
                                'Object from zk.get when a Buffer was ' +
                                'expected');
                            obj = _obj;
                        } else {
                            // If we reach this block it indicates an unexpected
                            // response from zookeeper. Just log the occurrence
                            // and move on.
                            log.warn({
                                path: self.path,
                                obj: _obj
                            }, 'onChildrenChanged::getChild: received ' +
                                'unexpected response from zk.get');
                        }

                        if (obj && obj.type === 'host') {
                            log.debug({
                                path: self.path,
                                host: obj
                            }, 'onChildrenChanged::getChild: host fetched');
                            _cb(null, obj.host.address);
                        } else {
                            /*
                             * webapi and loadbalancer instances both register
                             * themselves into the same domain, but as different
                             * types ("host" and "load_balancer", respectively).
                             * Here we effectively filter out anything but
                             * webapi instances.
                             */
                            _cb(null);
                        }
                    }
                });
            }

            children.push('6a05c503-0313-4666-a24c-5a24c2777f08');
            children.push('6a05c503-0313-4666-a24c-5a24c2777f09');
            children.push('6a05c503-0313-4666-a24c-5a24c2777f0a');
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
                    var emitError = false;
                    verror.errorForEach(err, function (getChildErr) {
                        if (getChildErr.name === 'ZKPingTimeoutError' &&
                            getChildErr.code === 'PING_TIMEOUT') {
                            /*
                             * There is no meaningful action to be taken for a
                             * zookeeper ping timeout. Muppet will be notified
                             * if the zookeeper session becomes invalid and can
                             * take action at that point. Log a debug message
                             * and otherwise ignore it.
                             */
                            log.debug({
                                path: getChildErr.path
                            }, 'onChildrenChanged: zookeeper ping timeout');
                        } else if (getChildErr.name === 'ZKError' &&
                            getChildErr.code === 'NO_NODE') {
                            /*
                             * Failed to fetch the information about a host from
                             * zookeeper. This need not be a fatal error. Log a
                             * warning and carry on with the set of hosts that
                             * we have info about.
                             */
                            log.warn({
                                path: getChildErr.path
                            }, 'onChildrenChanged: get host information ' +
                                'failed');
                        } else {
                            log.error({
                                path: getChildErr.path,
                                err: err
                            }, 'onChildrenChanged: get host information ' +
                                'failed');
                            emitError = true;
                        }
                    });

                    if (emitError) {
                        self.emit('error', err);
                        return;
                    }

                }

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
                    log.info({
                        path: self.path,
                        current: self.hosts,
                        new: hosts
                    }, 'onChildrenChanged: hosts differ, changing');
                    self.hosts = hosts;

                    // Emit updated hosts list
                    self.emit('hosts', self.hosts);
                } else {
                    log.info({
                        path: self.path,
                        current: self.hosts
                    }, 'onChildrenChanged: got hosts, but no changes');
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
