/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */


const mod_assert = require('assert-plus');
const mod_jsprim = require('jsprim');
const mod_restify = require('restify');
const mod_os = require('os');
const mod_util = require('util');

const HAPROXY_FRONTEND = '0';
const HAPROXY_BACKEND = '1';
const HAPROXY_SERVER = '2';

const HOSTNAME = mod_os.hostname();

/*
 * Helper functiions
 */
function isUp(status) {
    return ((status === 'UP') ? '1' : '0');
}

function msToSec(ms) {
    return ((ms / 1000).toString());
}

function haproxyComponentName(comp) {
    var componentName;
    switch (comp) {
        case '0':
            componentName = 'frontend';
        break;
        case '1':
            componentName =  'backend';
        break;
        case '2':
            componentName = 'server';
        break;
        default :
            componentName = 'unknown';
        break;
    }
    return (componentName);
}

/*
 * All haproxy metrics go in this array. We are trying to stay close
 * to the official HAProxy exporter by using the exact metric names.
 */
const HAPROXY_METRICS = [
    // Frontend Metrics
    {
        name: 'current_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Current number of active sessions.',
        stats: [ { statName: 'scur' } ]
    },
    {
        name: 'max_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Maximum observed number of active sessions.',
        stats: [ { statName: 'smax' } ]
    },
    {
        name: 'limit_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Configured session limit.',
        stats: [ { statName: 'slim' } ]
    },
    {
        name: 'sessions_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Total number of sessions.',
        stats: [ { statName: 'stot' } ]
    },
    {
        name: 'bytes_in_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Current total of incoming bytes.',
        stats: [ { statName: 'bin' } ]
    },
    {
        name: 'bytes_out_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Current total of outgoing bytes.',
        stats: [ { statName: 'bout' } ]
    },
    {
        name: 'requests_denied_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Total of requests denied for security.',
        stats: [ { statName: 'dreq' } ]
    },
    {
        name: 'request_errors_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Total of request errors.',
        stats: [ { statName: 'ereq' } ]
    },
    {
        name: 'current_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Current number of sessions per second over last elapsed second.',
        stats: [ { statName: 'rate' } ]
    },
    {
        name: 'limit_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Configured limit on new sessions per second.',
        stats: [ { statName: 'rate_lim' } ]
    },
    {
        name: 'max_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Maximum observed number of sessions per second.',
        stats: [ { statName: 'rate_max' } ]
    },
    {
        name: 'http_responses_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Total of HTTP responses.',
        stats: [
            {
                statName: 'hrsp_1xx',
                labels: { code: '1xx' }
            },
            {
                statName: 'hrsp_2xx',
                labels: { code: '2xx' }
            },
            {
                statName: 'hrsp_3xx',
                labels: { code: '3xx' }
            },
            {
                statName: 'hrsp_4xx',
                labels: { code: '4xx' }
            },
            {
                statName: 'hrsp_5xx',
                labels: { code: '5xx' }
            },
            {
                statName: 'hrsp_other',
                labels: { code: 'other' }
            }
        ]
    },
    {
        name: 'http_requests_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Total HTTP requests.',
        stats: [ { statName: 'req_tot' } ]
    },
    {
        name: 'compressor_bytes_in_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Number of HTTP response bytes fed to the compressor.',
        stats: [ { statName: 'comp_in' } ]
    },
    {
        name: 'compressor_bytes_out_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Number of HTTP response bytes emitted by the compressor.',
        stats: [ { statName: 'comp_out' } ]
    },
    {
        name: 'compressor_bytes_bypassed_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Number of bytes that bypassed the HTTP compressor.',
        stats: [ { statName: 'comp_byp' } ]
    },
    {
        name: 'http_responses_compressed_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Number of HTTP responses that were compressed.',
        stats: [ { statName: 'comp_rsp' } ]
    },
    {
        name: 'connections_total',
        type: 'counter',
        hpComponent: HAPROXY_FRONTEND,
        labels: { name: 'pxname' },
        desc: 'Total number of connections.',
        stats: [ { statName: 'conn_tot' } ]
    },

    // Backend Metrics
    {
        name: 'current_queue',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current number of queued requests not assigned to any server.',
        stats: [ { statName: 'qcur' } ]
    },
    {
        name: 'max_queue',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Maximum observed number of queued ' +
            'requests not assigned to any server.',
        stats: [ { statName: 'qmax' } ]
    },
    {
        name: 'current_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current number of active sessions.',
        stats: [ { statName: 'scur' } ]
    },
    {
        name: 'max_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Maximum observed number of active sessions.',
        stats: [ { statName: 'smax' } ]
    },
    {
        name: 'limit_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Configured session limit.',
        stats: [ { statName: 'slim' } ]
    },
    {
        name: 'sessions_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total number of sessions.',
        stats: [ { statName: 'stot' } ]
    },
    {
        name: 'bytes_in_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current total of incoming bytes.',
        stats: [ { statName: 'bin' } ]
    },
    {
        name: 'bytes_out_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current total of outgoing bytes.',
        stats: [ { statName: 'bout' } ]
    },
    {
        name: 'connection_errors_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total of connection errors.',
        stats: [ { statName: 'econ' } ]
    },
    {
        name: 'response_errors_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total of response errors.',
        stats: [ { statName: 'eresp' } ]
    },
    {
        name: 'retry_warnings_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total of retry warnings.',
        stats: [ { statName: 'wretr' } ]
    },
    {
        name: 'redispatch_warnings_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total of redispatch warnings.',
        stats: [ { statName: 'wredis' } ]
    },
    {
        name: 'up',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current health status of the backend (1 = UP, 0 = DOWN).',
        stats: [ { statName: 'status', modifier: isUp } ]
    },
    {
        name: 'weight',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total weight of the servers in the backend.',
        stats: [ { statName: 'weight' } ]
    },
    {
        name: 'current_server',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current number of active servers.',
        stats: [ { statName: 'act' } ]
    },
    {
        name: 'server_selected_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total number of times a server was selected, either ' +
            'for new sessions, or when re-dispatching.',
        stats: [ { statName: 'lbtot' } ]
    },
    {
        name: 'current_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Current number of sessions per second over last elapsed second.',
        stats: [ { statName: 'rate' } ]
    },
    {
        name: 'max_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Maximum number of sessions per second.',
        stats: [ { statName: 'rate_max' } ]
    },
    {
        name: 'http_responses_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total of HTTP responses.',
        stats: [
            {
                statName: 'hrsp_1xx',
                labels: { code: '1xx' }
            },
            {
                statName: 'hrsp_2xx',
                labels: { code: '2xx' }
            },
            {
                statName: 'hrsp_3xx',
                labels: { code: '3xx' }
            },
            {
                statName: 'hrsp_4xx',
                labels: { code: '4xx' }
            },
            {
                statName: 'hrsp_5xx',
                labels: { code: '5xx' }
            },
            {
                statName: 'hrsp_other',
                labels: { code: 'other' }
            }
        ]
    },
    {
        name: 'compressor_bytes_in_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Number of HTTP response bytes fed to the compressor.',
        stats: [ { statName: 'comp_in' } ]
    },
    {
        name: 'compressor_bytes_out_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Number of HTTP response bytes emitted by the compressor.',
        stats: [ { statName: 'comp_out' } ]
    },
    {
        name: 'compressor_bytes_bypassed_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Number of bytes that bypassed the HTTP compressor.',
        stats: [ { statName: 'comp_byp' } ]
    },
    {
        name: 'http_responses_compressed_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Number of HTTP responses that were compressed.',
        stats: [ { statName: 'comp_rsp' } ]
    },
    {
        name: 'http_queue_time_average_seconds',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Avg. HTTP queue time for last 1024 successful connections.',
        stats: [ { statName: 'qtime', modifier: msToSec } ]
    },
    {
        name: 'http_connect_time_average_seconds',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Avg. HTTP connect time for last 1024 successful connections.',
        stats: [ { statName: 'ctime', modifier: msToSec } ]
    },
    {
        name: 'http_response_time_average_seconds',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Avg. HTTP response time for last 1024 successful connections.',
        stats: [ { statName: 'rtime', modifier: msToSec } ]
    },
    {
        name: 'http_total_time_average_seconds',
        type: 'gauge',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Avg. HTTP total time for last 1024 successful connections.',
        stats: [ { statName: 'ttime', modifier: msToSec } ]
    },
    {
        name: 'transfers_aborted_by_client_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total number of data transfers aborted by the client.',
        stats: [ { statName: 'cli_abrt' } ]
    },
    {
        name: 'transfers_aborted_by_server_total',
        type: 'counter',
        hpComponent: HAPROXY_BACKEND,
        labels: { name: 'pxname' },
        desc: 'Total number of data transfers aborted by the server.',
        stats: [ { statName: 'srv_abrt' } ]
    },
    // Server Metrics
    {
        name: 'current_queue',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current number of queued requests assigned to this server.',
        stats: [ { statName: 'qcur' } ]
    },
    {
        name: 'max_queue',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Maximum observed number of ' +
            'queued requests assigned to this server.',
        stats: [ { statName: 'qmax'} ]
    },
    {
        name: 'current_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current number of active sessions.',
        stats: [ { statName: 'scur' } ]
    },
    {
        name: 'max_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Maximum observed number of active sessions.',
        stats: [ { statName: 'smax' } ]
    },
    /*
     * The current version of haproxy (1.8.20) doesn't
     * support 'slim' statistic for servers. It will be
     * exported when haproxy is upgraded to a newer version.
     */
    {
        name: 'limit_sessions',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Configured session limit.',
        stats: [ { statName: 'slim' } ]
    },
    {
        name: 'sessions_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total number of sessions.',
        stats: [ { statName: 'stot' } ]
    },
    {
        name: 'bytes_in_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current total of incoming bytes.',
        stats: [ { statName: 'bin' } ]
    },
    {
        name: 'bytes_out_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current total of outgoing bytes.',
        stats: [ { statName: 'bout' } ]
    },
    {
        name: 'connection_errors_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total of connection errors.',
        stats: [ { statName: 'econ' } ]
    },
    {
        name: 'response_errors_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total of response errors.',
        stats: [ { statName: 'eresp' } ]
    },
    {
        name: 'retry_warnings_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total of retry warnings.',
        stats: [ { statName: 'wretr' } ]
    },
    {
        name: 'redispatch_warnings_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total of redispatch warnings.',
        stats: [ { statName: 'wredis' } ]
    },
    {
        name: 'up',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current health status of the server (1 = UP, 0 = DOWN).',
        stats: [ { statName: 'status', modifier: isUp } ]
    },
    {
        name: 'weight',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current weight of the server.',
        stats: [ { statName: 'weight' } ]
    },
    {
        name: 'check_failures_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total number of failed health checks.',
        stats: [ { statName: 'chkfail' } ]
    },
    {
        name: 'downtime_seconds_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total downtime in seconds.',
        stats: [ { statName: 'downtime' } ]
    },
    {
        name: 'server_selected_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total number of times a server was selected, ' +
            'either for new sessions, or when re-dispatching.',
        stats: [ { statName: 'lbtot' } ]
    },
    {
        name: 'current_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Current number of sessions per second ' +
            'over last elapsed second.',
        stats: [ { statName: 'rate' } ]
    },
    {
        name: 'max_session_rate',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Maximum observed number of sessions per second.',
        stats: [ { statName: 'rate_max' } ]
    },
    {
        name: 'check_duration_milliseconds',
        type: 'gauge',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Previously run health check duration, in milliseconds.',
        stats: [ { statName: 'check_duration' } ]
    },
    {
        name: 'http_responses_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total of HTTP responses.',
        stats: [
            {
                statName: 'hrsp_1xx',
                labels: { code: '1xx' }
            },
            {
                statName: 'hrsp_2xx',
                labels: { code: '2xx' }
            },
            {
                statName: 'hrsp_3xx',
                labels: { code: '3xx' }
            },
            {
                statName: 'hrsp_4xx',
                labels: { code: '4xx' }
            },
            {
                statName: 'hrsp_5xx',
                labels: { code: '5xx' }
            },
            {
                statName: 'hrsp_other',
                labels: { code: 'other' }
            }
        ]
    },
    {
        name: 'transfers_aborted_by_client_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total number of data transfers aborted by the client.',
        stats: [ { statName: 'cli_abrt' } ]
    },
    {
        name: 'transfers_aborted_by_server_total',
        type: 'counter',
        hpComponent: HAPROXY_SERVER,
        labels: { name: 'pxname', address: 'addr' },
        desc: 'Total number of data transfers aborted by the server.',
        stats: [ { statName: 'srv_abrt' } ]
    }
];


function MetricsExporter(opts) {
    mod_assert.object(opts, 'opts');
    mod_assert.object(opts.log, 'opts.log');
    mod_assert.object(opts.haSock, 'opts.haSock');
    mod_assert.arrayOfString(opts.adminIPS, 'opts.adminIPS');
    mod_assert.number(opts.metricsPort, 'opts.metricsPort');
    mod_assert.ok(opts.adminIPS.length > 0, 'opts.adminIPS.length > 0');


    var self = this;
    self.log =  opts.log.child({component: 'metrics-exporter'});
    self.haSock = opts.haSock;

    self.server = mod_restify.createServer({
        name: 'muppet-metrics-exporter',
        log: self.log,
        handleUncaughtExceptions: false,
        handleUpgrades: false
    });

    self.server.use(function _addStandardRespHeaders(req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', self.server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', HOSTNAME);
        });
        req.metricExporter = self;
        next();
    });

    self.server.use(mod_restify.plugins.requestLogger());

    self.server.on('after', function audit(req, res, route, err) {
        // Successful GET res bodies are uninteresting and *big*.
        var body = !(req.method === 'GET' &&
            Math.floor(res.statusCode / 100) === 2);

        mod_restify.plugins.auditLogger({
            log: req.log.child({
                route: route && route.name,
                action: req.query.action
            }, true),
            event: 'after',
            body: body
        })(req, res, route, err);
    });

    // Register /metrics handler
    self.server.get('/metrics', getMetricsHandler);
    self.address = opts.adminIPS[0];
    self.port = opts.metricsPort;
}

MetricsExporter.prototype.start = function (cb) {
    mod_assert.optionalFunc(cb);
    this.server.listen(this.port, this.address, cb);
};

MetricsExporter.prototype.close = function (cb) {
    mod_assert.optionalFunc(cb);
    this.server.close(cb);
};

function createMetricString(opts) {
    mod_assert.object(opts, 'opts');
    mod_assert.string(opts.metricName, 'opts.metricName');
    mod_assert.string(opts.metricType, 'opts.metricType');
    mod_assert.string(opts.metricDocString, 'opts.metricDocString');
    mod_assert.arrayOfObject(opts.metricLabels, 'opts.metricLabels');
    mod_assert.arrayOfString(opts.metricValues, 'opts.metricValues');
    mod_assert.ok(opts.metricLabels.length === opts.metricValues.length,
        'opts.metricLabels.length === opts.metricValues.length');

    var metricString = '# HELP ' +
        opts.metricName + ' ' + opts.metricDocString + '\n' +
        '# TYPE ' + opts.metricName + ' ' + opts.metricType;

    for (var i = 0; i < opts.metricLabels.length; i++) {
        metricString += '\n';
        metricString += (opts.metricName + '{');

        var firstLabel = true;
        Object.keys(opts.metricLabels[i]).forEach(function (key) {
            var value = opts.metricLabels[i][key];

            mod_assert.string(key, 'key');
            mod_assert.ok(key.indexOf('"') === -1, 'key');
            mod_assert.string(value, 'value');
            mod_assert.ok(value.indexOf('"') === -1, 'value');

            if (!firstLabel) {
                metricString += ',';
            }
            firstLabel = false;

            metricString += (key + '="' + value + '"');
        });

        metricString += '} ' + opts.metricValues[i];
    }


    return (metricString + '\n');
}

function getMetricsHandler(req, res, next) {

    req.metricExporter.haSock.allStats({ log: req.metricExporter.log },
       function _gotSrvStats(err, allStats) {
        if (err) {
            req.metricExporter.log.error(err);
            next(err);
            return;
        }

        var metricsString = '';
        HAPROXY_METRICS.forEach(function _buildServerMetric(metric) {

            var metricLabels = [];
            var metricValues = [];
            var componentName = haproxyComponentName(metric.hpComponent);

            /*
             * Filter out stats not related to this metric. This
             * is needed because haproxy uses the same stat name
             * for different components (fronend, backend, and server)
             */
            allStats.filter(function (stat) {
                return (stat.type === metric.hpComponent);
            }).forEach(function _serverStat(stat) {

                // Populate metric labels
                var labels = mod_jsprim.deepCopy(metric.labels);
                Object.keys(labels).forEach(function (key) {
                    labels[key] = stat[labels[key]] || '';
                });

                // Process stats in each metric
                metric.stats.forEach(function _processMetricStats(metricStat) {
                    var value = stat[metricStat.statName];
                    if (value) {
                        if (metricStat.modifier) {
                            value = metricStat.modifier(value);
                        }

                        var metricStatLabels = mod_jsprim.mergeObjects(
                            {'component': componentName, 'inst_id': HOSTNAME},
                            labels, metricStat.labels);

                        metricLabels.push(metricStatLabels);
                        metricValues.push(value);
                    }
                });
            });

            // Stop processing this metric in case no stat has been found
            if (metricValues.length === 0) {
                return;
            }

            var metricName = mod_util.format('loadbalancer_%s_%s',
                componentName, metric.name);

            var metricOpts = {
                metricName: metricName,
                metricType: metric.type,
                metricDocString: metric.desc,
                metricLabels: metricLabels,
                metricValues: metricValues
            };

            metricsString += createMetricString(metricOpts);
        });

        res.header('content-type', 'text/plain');
        res.send(metricsString);
        next();
    });
}

function createMetricsExporter(opts) {
    return (new MetricsExporter(opts));
}

module.exports = {
    createMetricsExporter: createMetricsExporter
};
