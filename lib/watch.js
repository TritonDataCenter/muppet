/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var assert = require('assert-plus');
var once = require('once');
var vasync = require('vasync');
var jsprim = require('jsprim');



///--- Globals

var sprintf = util.format;



///--- Private Functions

function domainToPath(domain) {
    return ('/' + domain.split('.').reverse().join('/'));
}



///--- API

function Watch(options) {
    assert.ok(options);
    assert.ok(options.domain);
    assert.ok(options.log);
    assert.ok(options.zk);

    EventEmitter.call(this);

    // sometimes you suck, node:
    // https://github.com/joyent/node/blob/v0.8.9-release/lib/events.js#L79
    // ensure that this.emit('foo') generates a null deref.
    this.hosts = [];
    this.log = options.log.child({clazz: 'Watch'}, true);
    this.path = domainToPath(options.domain);
    this.zk = options.zk;
}
util.inherits(Watch, EventEmitter);


Watch.prototype.start = function start(callback) {
    callback = once(callback);

    var log = this.log;
    var self = this;
    var tasks = [];
    var zk = this.zk;

    log.debug({
        path: self.path
    }, 'start: entered');

    tasks.push(function mkdir(_, cb) {
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'start: ensuring directory exists');
        zk.mkdirp(self.path, cb);
    });

    tasks.push(function watch(_, cb) {
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'start: setting watch');
        var opts = {
            initialData: true,
            method: 'list'
        };
        zk.watch(self.path, opts, function (err, watcher) {
            if (err) {
                cb(err);
            } else {
                self.watcher = watcher;
                cb();
            }
        });
    });

    tasks.push(function setup(_, cb) {
        cb = once(cb);

        log.debug({
            path: self.path
        }, 'start: watch started; registering hooks');

        self.watcher.on('error', function onWatchError(watchErr) {
            log.error({
                path: self.path,
                err: watchErr
            }, 'watcher: error from ZooKeeper');
            self.emit('error', watchErr);
        });

        self.watcher.on('children', function onChildren(children) {
            log.debug({
                path: self.path,
                children: children
            }, 'onChildren: watch fired');

            function getChild(c, _cb) {
                var p = self.path + '/' + c;
                zk.get(p, function (err, obj) {
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
            }, 'start: watching');

            if (typeof (callback) === 'function')
                callback(null);

            process.nextTick(function () {
                self.emit('start');
            });
        }
    });
};


Watch.prototype.stop = function stop() {
    if (this.watcher)
        this.watcher.stop();
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
