/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*jsl:ignore*/
'use strict';
/*jsl:end*/

const lib_hasock = require('../lib//haproxy_sock');
const metrics_exporter = require('../lib/metrics_exporter');
const bunyan = require('bunyan');

const helper = require('./helper.js');
const http = require('http');
const tap = require('tap');

var log = helper.createLogger();

tap.beforeEach(function (cb, t) {
    helper.startHaproxy(cb);
});

tap.afterEach(function (cb, t) {
    helper.killHaproxy(cb);
});

tap.test('start and close metrics server', function (t) {
    var opts = {
        log: bunyan.createLogger({ name: 'dummy' }),
        adminIPS: ['127.0.0.1'],
        metricsPort: 12421,
        haSock: lib_hasock
    };
    var me = metrics_exporter.createMetricsExporter(opts);
    me.start(function (err) {
        if (err) {
            t.fail(err);
            return;
        }
        me.close(t.done);
    });
});


const NUMBER_REG_EXP =
    '[-+]?' +
    '(?:[0-9]{0,30}\\.)?' +
    '[0-9]{1,30}' +
    '(?:[Ee][-+]?[1-2]?[0-9])?';

tap.test('metrics server is producing valid metrics', function (t) {
    var opts = {
        log: bunyan.createLogger({ name: 'dummy' }),
        adminIPS: ['127.0.0.1'],
        metricsPort: 12421,
        haSock: lib_hasock
    };

    // XXX: This is not full validation by any means.
    function validateMetrics(metrics) {

        if (metrics.length === 0) {
            t.fail('Metrics server returned no metrics');
            return;
        }
        var lines = metrics.trim().split('\n');
        var re = [
            '(^# HELP \.*$)',
            '(^# TYPE \.* (counter|gauge|histogram)$)',
            '(^([\\w_]*) ' + NUMBER_REG_EXP + '$)',
            '(^([\\w_]*)(\\{(.*)\\})? ' + NUMBER_REG_EXP + '$)'
        ];

        var regExp = new RegExp(re.join('|'));
        var invalidMetrics = lines.some(function (line) {
            if (regExp.test(line) === false) {
                t.fail('Invalid Metric line: ' + line);
                return (true);
            }
            return (false);
        });

        if (!invalidMetrics)
            t.done();
    }

    var me = metrics_exporter.createMetricsExporter(opts);
    me.start(function (err1) {
        if (err1) {
            t.fail(err1);
            return;
        }

        var body = '';
        var reqOpts = {
            host: opts.adminIPS[0],
            port: opts.metricsPort,
            path: '/metrics'
        };

        var req = http.request(reqOpts, function (res) {
            res.on('data', function (chunk) {
                body += chunk;
            });

            res.on('end', function () {
                me.close(function (err2) {
                    if (err2) {
                        t.fail(err2);
                        return;
                    }
                    validateMetrics(body);
                });
            });
        });

        req.on('error', function (err2) {
             me.close(function () { t.fail(err2); });
        });
        req.end();
    });
});
