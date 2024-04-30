---
title: Muppet: Manta loadbalancer
markdown2extras: tables, code-friendly
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
    Copyright 2024 MNX Cloud, Inc.
-->

# Overview

This repository builds the "manta-loadbalancer" image that is the public access
point of a Manta installation (such as `https://manta.region.example.com/`).
Multiple instances can be configured and are themselves load-balanced on the
client side via DNS lookup.

Each instance runs `haproxy`, which routes requests to the backend servers,
and `muppet`, which manages `haproxy` configuration.

## Load Balancer

The loadbalancer used is [HAProxy](http://www.haproxy.org/).

Requests are routed to either [webapi](https://github.com/TritonDataCenter/manta-muskie/)
or [buckets-api](https://github.com/TritonDataCenter/manta-buckets-api) API
server instances as needed.  All `http` requests not matching the route
`/:login/buckets/` are considered to be directory-style requests.

*Important:* `muppet` is in control of the actual live configuration, and any
configuration changes should be made there. In particular, modifications of the
live `/opt/smartdc/muppet/etc/haproxy.cfg` may be over-written by `muppet` at
will.

`haproxy` is configured to handle SSL termination. The certificate used is
managed by `config-agent`, and can be updated in the Manta deployment zone using
[manta-replace-cert](https://github.com/TritonDataCenter/sdc-manta/blob/master/cmd/manta-replace-cert.js).
This updates the SAPI metadata key `SSL_CERTIFICATE`, and be used without
interrupting loadbalancer service.

`haproxy` is set up to log (via syslog) to `/var/log/haproxy.log` in a format
that apes [bunyan](https://github.com/trentm/node-bunyan), to allow use of the
`bunyan(1)` CLI, `tail -f /var/log/haproxy | json -ga`, etc. Only the request
header `x-request-id` is logged. The meaning of the fields can be found in the
[haproxy configuration
manual](https://cbonte.github.io/haproxy-dconv/2.0/configuration.html). They're
generally self explanatory, except:

 - `time`: this is the timestamp haproxy received the first byte of the request
 - `retries`: count of server connection retries
 - `res_bytes_read`: size of response to client
 - `timers.req`: request read time, excluding request body (%TR)
 - `timers.queued`: time queued in haproxy (%Tw)
 - `timers.server_conn`: server connection time (%Tc)
 - `timers.res`: time for server response, excluding response body (%Tr)
 - `timers.total`: total request-to-response time, including body (%Ta)

See [Timing
events](https://cbonte.github.io/haproxy-dconv/2.0/configuration.html#8.4) for
handy ASCII art on the timer's exact meanings.

## Muppet

There is an `haproxy.cfg.in` template file; this is used by `muppet` to generate
a new `haproxy.cfg` each time the topology of online API servers changes.

The `muppet` daemon directly connects to the
[registrar](https://github.com/TritonDataCenter/registrar) Zookeeper set up
looking for changes to nodes under the `manta` (for `webapi`) or `buckets-api`
path.  As backend servers come and go, the `haproxy` backend server
configuration is updated as needed. If possible, we dynamically disable/enable
the servers by talking to the `haproxy` management interface; if not, then we
refresh `haproxy`, which starts a new child process without interrupting
existing connections.

Note that `haproxy` itself is configured to do basic health checks on the
backend servers, and will retire use of any unhealthy servers.

## SAPI configuration

The metadata key `SSL_CERTIFICATE` of the loadbalancer SAPI service should
contain the text of the private key used as the `haproxy` certificate; see
above.

The metadata key `HAPROXY_NBTHREAD` defines the number of `haproxy` worker
threads. The default is `20`. Changing this requires restarting `muppet` but
shouldn't interrupt `haproxy` service.
