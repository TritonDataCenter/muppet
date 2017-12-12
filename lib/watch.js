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

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var assert = require('assert-plus');
var once = require('once');
var vasync = require('vasync');
var jsprim = require('jsprim');


///--- Globals

const sprintf = util.format;

///--- Private Functions

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
    }, 'Watch start: entered');

    tasks.push(function mkdirp(_, cb) {
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'Watch start: ensuring directory exists');
        var nullBuffer = new Buffer('null', 'ascii');
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
        }, 'Watch start: setting watch');

        self.watcher = zk.watcher(self.path);
        cb(null);
    });

    tasks.push(function setup(_, cb) {
        assert.object(self.watcher);
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'Watch start: registering hooks');

        self.watcher.on('error', function onWatchError(watchErr) {
            log.error({
                path: self.path,
                err: watchErr
            }, 'onWatchError: error from ZooKeeper');
            self.emit('error', watchErr);
        });

        self.watcher.on('childrenChanged', function onChildren(children) {
            log.debug({
                path: self.path,
                children: children
            }, 'onChildrenChanged: watch fired');

            function getChild(c, _cb) {
                var p = self.path + '/' + c;
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
                        }, 'onChildren: host fetched');
                        _cb(null, obj.host.address);
                    }
                });
            }

            var opts = {
                func: getChild,
                inputs: children
            };
            vasync.forEachParallel(opts, function (err, res) {
                if (err) {
                    log.error({
                        path: self.path,
                        err: err
                    }, 'watch: getChild failed');
                    self.emit('error', err);
                } else {
                    log.debug({
                        children: res
                    }, 'watch: children');
                    var hosts = [];
                    // This little snippet just drops
                    // nulls and duplicates
                    res.successes.filter(function (h) {
                        return (h);
                    }).forEach(function (h) {
                        if (hosts.indexOf(h) < 0)
                            hosts.push(h);
                    });
                    hosts.sort();

                    /*
                     * Only emit if the set of webapi instances has
                     * changed.
                     */
                    if (!jsprim.deepEqual(hosts, self.hosts)) {
                        self.hosts = hosts;
                        log.info({
                            path: self.path,
                            hosts: self.hosts
                        }, 'watch: hosts updated');
                        self.emit('hosts', self.hosts);
                    } else {
                        log.info({
                            path: self.path,
                            new: hosts,
                            current: self.hosts
                        }, 'watch: got hosts, but no changes');
                    }
                }
            });
        });
        cb();
    });

    // Kick off the mkdirp -> watch -> register pipeline
    vasync.pipeline({ funcs: tasks }, function (err) {
        if (err) {
            log.error({
                path: self.path,
                err: err
            }, 'start: ZK error');
            if (typeof (callback) === 'function') {
                callback(err);
            } else {
                self.emit('error', err);
            }
        } else {
            log.debug({
                path: self.path
            }, 'Watch start: watching successful');

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
