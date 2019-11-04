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
-->

# Overview

This repository builds the "manta-loadbalancer" image that is the public access
point of a Manta installation (such as `https://manta.region.example.com/`).
Multiple instances can be configured and are themselves load-balanced on the
client side via DNS lookup.

Each instance runs `haproxy`, which routes requests to the backend servers,
and `muppet`, which manages `haproxy` configuration.

## Load Balancer

The loadbalancer used is [HAProxy](http://www.haproxy.org/). It logs via syslog
to `/var/log/haproxy.log`.

Requests are routed to either [webapi](https://github.com/joyent/manta-muskie/)
or [buckets-api](https://github.com/joyent/manta-buckets-api) API server
instances as needed.  All `http` requests not matching the route
`/:login/buckets/` are considered to be directory-style requests.

*Important:* `muppet` is in control of the actual live configuration, and any
configuration changes should be made there. In particular, modifications of the
live `/opt/smartdc/muppet/etc/haproxy.cfg` may be over-written by `muppet` at
will.

`haproxy` is configured to handle SSL termination. The certificate used is
managed by `config-agent`, and can be updated in the Manta deployment zone using
[manta-replace-cert](https://github.com/joyent/sdc-manta/blob/master/cmd/manta-replace-cert.js).

## Muppet

There is an `haproxy.cfg.in` file that is templated with a sparse number of
`%s`; this file is used by `muppet` to generate a new `haproxy.cfg` each time
the topology of online loadbalancers changes.

The `muppet` daemon directly connects to the
[registrar](https://github.com/joyent/registrar) Zookeeper set up looking for
changes to nodes under the `manta` (for `webapi`) or `buckets-api` path.  As
backend servers come and go, the `haproxy` backend server configuration is
updated as needed. If possible, we dynamically disable/enable the servers by
talking to the `haproxy` management interface; if not, then we refresh
`haproxy`, which starts a new child process without interrupting existing
connections.

Note that `haproxy` itself is configured to do basic health checks on the
backend servers, and will retire use of any unhealthy servers.
