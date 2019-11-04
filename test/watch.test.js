/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Note that the tests here use explicit timeouts to check the FSM timeouts of
 * the watcher behave as expected, in a somewhat black-box fashion. To make the
 * tests run faster, though, we dial down the real-life timeouts.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const helper = require('./helper.js');
const mod_vasync = require('vasync');
const tap = require('tap');
const watch = require('../lib/watch.js');

var log = helper.createLogger();

const COLLECTION_TIMEOUT = 500;
const HOLD_TIME = 3000;
const RETRY_TIMEOUT = 1500;
const SMEAR = 0;

function MockZookeeper() {
    this.res = {};
    this.res_no_node = {};
    this.res_error = {};
    this.connected = true;
}

MockZookeeper.prototype.get = function (path, cb) {
    if (this.res_no_node[path]) {
        cb({ name: 'ZKError', code: 'NO_NODE'});
        return;
    } else if (this.res_error[path]) {
        cb({ name: this.res_error[path], code: 'ZK_ERROR'});
        return;
    }
    cb(null, this.res[path]);
};

MockZookeeper.prototype.isConnected = function () {
    return (this.connected);
};

function setup(zk) {
    var watcher = new watch.ServerWatcherFSM({
        zk: new MockZookeeper(),
        log: log
    });

    watcher.sw_collectionTimeout = COLLECTION_TIMEOUT;
    watcher.sw_holdTime = HOLD_TIME;
    watcher.sw_retryTimeout = RETRY_TIMEOUT;
    watcher.sw_smearTime = SMEAR;

    return (watcher);
}

tap.test('test collecting serversChanged', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });

    /*
     * We're testing the collection period here: we expect that after multiple
     * nodesChanged() calls during COLLECTION_TIME, we only get one final
     * serversChanged() emitted, with the final child list of c1,c2.
     */

    watcher.on('serversChanged', function (servers) {
        t.comment('serversChanged: expecting c1,c2');
        t.equal(servers['c1'].address, '127.0.0.1');
        t.equal(servers['c2'].address, '127.0.0.2');
        t.done();
    });

    t.comment('adding c1');
    watcher.nodesChanged('/p/manta', ['c1']);

    setTimeout(function () {
        t.comment('adding c2,c3');
        watcher.nodesChanged('/p/manta', ['c1', 'c2', 'c3']);
        setTimeout(function () {
            t.comment('removing c3');
            watcher.nodesChanged('/p/manta', ['c1', 'c2']);
        }, 100);
    }, 100);
});

tap.test('test no net change', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });

    t.comment('adding c1');
    watcher.nodesChanged('/p/manta', ['c1']);

    // wait for the first notification, then proceed
    setTimeout(function () {
        watcher.on('serversChanged', function (servers) {
            t.fail('got serversChanged');
        });

        // wait until we're confident we're not going to get serversChanged()
        setTimeout(function () {
            t.done();
        }, COLLECTION_TIMEOUT + 300);

        setTimeout(function () {
            t.comment('adding c2');
            watcher.nodesChanged('/p/manta', ['c1', 'c2']);
            setTimeout(function () {
                t.comment('back to just c1');
                watcher.nodesChanged('/p/manta', ['c1']);
            }, 100);
        }, 100);
    }, COLLECTION_TIMEOUT + 300);

});

tap.test('test hold time', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });
    watcher.sw_zk.res['/p/manta/c3'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.3' }
    });

    t.comment('adding c1, c2');
    watcher.nodesChanged('/p/manta', ['c1', 'c2']);

    var ok = false;

    setTimeout(function () {
        watcher.on('serversChanged', function (servers) {
            t.comment('got serversChanged with ok ' + ok);
            t.ok(ok, 'serversChanged expected');
            if (ok) {
                t.ok(servers['c1']);
                t.notOk(servers['c2']);
                t.done();
            }
        });

        setTimeout(function () {
            t.comment('removing c2');
            watcher.nodesChanged('/p/manta', ['c1']);
            t.comment('expecting c2 to stay');

            setTimeout(function () {
                ok = true;
                t.comment('expecting c2 removal');
            }, COLLECTION_TIMEOUT + 300);
        }, COLLECTION_TIMEOUT + 300);
    }, COLLECTION_TIMEOUT + 300);

});

tap.test('test non-host nodes', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'load_balancer', host: { address: '127.0.0.2' }
    });

    watcher.on('serversChanged', function (servers) {
        t.equal(servers['c1'].address, '127.0.0.1');
        t.notOk(servers['c2']);
        t.done();
    });

    t.comment('adding load_balancer c2');
    watcher.nodesChanged('/p/manta', ['c1', 'c2']);
});

tap.test('test buckets-api nodes', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'load_balancer', host: { address: '127.0.0.2' }
    });
    watcher.sw_zk.res['/p/buckets-api/c3'] = JSON.stringify({
        type: 'load_balancer', 'load_balancer': {
            address: '127.0.0.3', ports: [ '8081', '8082' ]
        }
    });
    watcher.sw_zk.res['/p/buckets-api/c4'] = JSON.stringify({
        type: 'load_balancer', 'load_balancer': {
            address: '127.0.0.4', ports: [ '8081', '8082' ]
        }
    });

    watcher.on('serversChanged', function (servers) {
        t.equal(servers['c1'].address, '127.0.0.1');
        t.equal(servers['c1'].kind, 'webapi');
        t.notOk(servers['c2']);
        t.equal(servers['c3'].address, '127.0.0.3');
        t.equal(servers['c3'].kind, 'buckets-api');
        t.equal(servers['c3'].ports[0], '8081');
        t.equal(servers['c3'].ports[1], '8082');
        t.equal(servers['c4'].address, '127.0.0.4');
        t.equal(servers['c4'].kind, 'buckets-api');
        t.equal(servers['c4'].ports[0], '8081');
        t.equal(servers['c4'].ports[1], '8082');
        t.done();
    });

    t.comment('adding manta load_balancer c2, buckets-api c3, c4');

    watcher.nodesChanged('/p/manta', [ 'c1', 'c2' ]);
    watcher.nodesChanged('/p/buckets-api', [ 'c3', 'c4' ]);
});

tap.test('test NO_NODE response', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res_no_node['/p/manta/c2'] = true;

    t.comment('adding c1, NO_NODE c2');
    watcher.nodesChanged('/p/manta', ['c1', 'c2']);

    watcher.on('serversChanged', function (servers) {
        t.equal(servers['c1'].address, '127.0.0.1');
        t.notOk(servers['c2']);
        t.done();
    });
});

tap.test('test ZK error response', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });
    watcher.sw_zk.res['/p/manta/c3'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.3' }
    });

    watcher.sw_zk.res_error['/p/manta/c2'] = 'lost connection';

    t.comment('adding c1, c2, c3');
    watcher.nodesChanged('/p/manta', ['c1', 'c2', 'c3']);

    watcher.on('serversChanged', function (servers) {
        t.comment('serversChanged arrived');
        t.equal(servers['c1'].address, '127.0.0.1');
        t.equal(servers['c2'].address, '127.0.0.2');
        t.equal(servers['c3'].address, '127.0.0.3');
        t.notOk(watcher.sw_zk.res_error['/p/manta/c2']);
        t.done();
    });

    t.comment('running in ZK failure mode');
    setTimeout(function () {
        t.comment('fixing up ZK to work again');
        watcher.sw_zk.res_error['/p/manta/c2'] = undefined;
    }, COLLECTION_TIMEOUT + 300);
});

tap.test('test removal throttle', {timeout: 40000}, function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });
    watcher.sw_zk.res['/p/manta/c3'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.3' }
    });
    watcher.sw_zk.res['/p/manta/c4'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.4' }
    });
    watcher.sw_zk.res['/p/manta/c5'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.5' }
    });
    watcher.sw_zk.res['/p/manta/c6'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.6' }
    });
    watcher.sw_zk.res['/p/manta/c7'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.7' }
    });
    watcher.sw_zk.res['/p/manta/c8'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.8' }
    });
    watcher.sw_zk.res['/p/manta/c9'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.9' }
    });
    watcher.sw_zk.res['/p/manta/ca'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.10' }
    });

    t.comment('adding c1-ca');
    watcher.nodesChanged('/p/manta', ['c1', 'c2', 'c3', 'c4', 'c5',
        'c6', 'c7', 'c8', 'c9', 'ca']);

    // NB: this is relying on removal sort ordering by name
    var expect = [
        [ 'c1', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'ca' ],
        [ 'c1', 'c6', 'c7', 'c8', 'c9', 'ca' ],
        [ 'c1', 'c8', 'c9', 'ca' ],
        [ 'c1', 'c9', 'ca' ],
        [ 'c1', 'ca' ],
        [ 'c1' ]
    ];

    var count = 0;

    setTimeout(function () {
        watcher.on('serversChanged', function (servers) {
            t.comment('checking server list is as expected: got ' +
                JSON.stringify(servers));
            expect[count].forEach(function (s) {
                t.ok(servers[s]);
            });

            count += 1;
            if (count === expect.length)
                t.done();
        });

        t.comment('removing c2-ca');
        watcher.nodesChanged('/p/manta', ['c1']);

    }, COLLECTION_TIMEOUT + 300);
});

tap.test('test last seen removal ordering', function (t) {
    var watcher = setup();

    watcher.sw_zk.res['/p/manta/c1'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.1' }
    });
    watcher.sw_zk.res['/p/manta/c2'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.2' }
    });
    watcher.sw_zk.res['/p/manta/c3'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.3' }
    });
    watcher.sw_zk.res['/p/manta/c4'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.4' }
    });
    watcher.sw_zk.res['/p/manta/c5'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.5' }
    });
    watcher.sw_zk.res['/p/manta/c6'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.6' }
    });
    watcher.sw_zk.res['/p/manta/c7'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.7' }
    });
    watcher.sw_zk.res['/p/manta/c8'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.8' }
    });
    watcher.sw_zk.res['/p/manta/c9'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.9' }
    });
    watcher.sw_zk.res['/p/manta/ca'] = JSON.stringify({
        type: 'host', host: { address: '127.0.0.10' }
    });

    t.comment('adding c1-ca');
    watcher.nodesChanged('/p/manta', ['c1', 'c2', 'c3', 'c4', 'c5',
        'c6', 'c7', 'c8', 'c9', 'ca']);

    // NB: this is relying on removal sort ordering by name as well as last seen
    var expect = [
        [ 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'ca' ],
        [ 'c1', 'c2', 'c3', 'c4', 'c7', 'c8', 'c9', 'ca' ],
        [ 'c1', 'c3', 'c4', 'c8', 'c9', 'ca' ],
        [ 'c1', 'c8', 'c9', 'ca' ]
    ];

    var count = 0;

    watcher.on('serversChanged', function (servers) {
        t.comment('checking server list is as expected: got ' +
            JSON.stringify(servers));
        expect[count].forEach(function (s) {
            t.ok(servers[s]);
        });

        count += 1;
        if (count === expect.length)
            t.done();
    });

    mod_vasync.pipeline({'funcs': [
        function (_, cb) {
            setTimeout(function () {
                t.comment('remove c5-c7');
                watcher.nodesChanged('/p/manta', ['c1', 'c2', 'c3', 'c4',
                    'c8', 'c9', 'ca']);
                cb();
            }, COLLECTION_TIMEOUT + 300);
        },
        function (_, cb) {
            setTimeout(function () {
                t.comment('remove c2-c4');
                watcher.nodesChanged('/p/manta', ['c1', 'c8', 'c9', 'ca']);
                cb();
            }, COLLECTION_TIMEOUT + 300);
        }
    ]}, function () { });
});
