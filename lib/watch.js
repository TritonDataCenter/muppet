//  Copyright (c) 2012, Joyent, Inc. All rights reserved.

var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var vasync = require('vasync');



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

        this.domain = options.domain;
        this.hosts = [];
        this.log = options.log.child({clazz: 'Watch'}, true);
        this.path = domainToPath(this.domain);
        this.zk = options.zk;
}
util.inherits(Watch, EventEmitter);


Watch.prototype.start = function start(callback) {
        var log = this.log;
        var self = this;
        var tasks = [];
        var zk = this.zk;

        log.debug({
                domain: self.domain,
                path: self.path
        }, 'start: entered');

        tasks.push(function mkdir(_, cb) {
                log.debug({
                        domain: self.domain,
                        path: self.path
                }, 'start: ensuring directory exists');
                zk.mkdirp(self.path, cb);
        });

        tasks.push(function watch(_, cb) {
                log.debug({
                        domain: self.domain,
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
                log.debug({
                        domain: self.domain,
                        path: self.path
                }, 'start: watch started; registering hooks');

                self.watcher.on('error', function onWatchError(watchErr) {
                        log.error({
                                domain: self.domain,
                                path: self.path,
                                err: watchErr
                        }, 'watcher: error from ZooKeeper');
                        self.emit('error', watchErr);
                });

                self.watcher.on('children', function onChildren(children) {
                        log.debug({
                                domain: self.domain,
                                path: self.path,
                                children: children
                        }, 'onChildren: watch fired');

                        function getChild(c, _cb) {
                                var p = self.path + '/' + c;
                                zk.get(p, function (err, obj) {
                                        if (err) {
                                                _cb(err);
                                        } else if (obj.type !== 'host') {
                                                _cb(null);
                                        } else {
                                                log.debug({
                                                        path: self.path,
                                                        domain: self.domain,
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
                                                domain: self.domain,
                                                path: self.path,
                                                err: err
                                        }, 'watch: getChild failed');
                                        self.emit('error', err);
                                } else {
                                        // This little snippet just drops
                                        // nulls and duplicates
                                        self.hosts = [];
                                        res.successes.filter(function (h) {
                                                return (h);
                                        }).forEach(function (h) {
                                                if (self.hosts.indexOf(h) < 0)
                                                        self.hosts.push(h);
                                        });

                                        log.info({
                                                domain: self.domain,
                                                path: self.path,
                                                hosts: self.hosts
                                        }, 'watch: hosts updated');

                                        self.emit('hosts', self.hosts);
                                }
                        });
                });
                cb();
        });

        // Kick off the mkdirp -> watch -> register pipeline
        vasync.pipeline({ funcs: tasks }, function (err) {
                if (err) {
                        log.error({
                                domain: self.domain,
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
                                domain: self.domain,
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
        str += sprintf('domain=%s,', this.domain);
        str += sprintf('path=%s,', (this.path || 'null'));
        str += sprintf('hosts=%j', (this.hosts || []));
        str += '>]';
        return (str);
};



///--- Exports

module.exports = {
        Watch: Watch
};
