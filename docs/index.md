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

# tl;dr

muppet is a custom loadbalancing solution that runs haproxy and a daemon that
watches group membership changes in ZooKeeper.

# Overview

In manta at least, all configuration of the load balancer is automatically
managed by the muppet service, which watches for registrar changes in ZooKeeper.
This updates the upstream server list of IP addresses and refreshes the haproxy
loadbalancer service as appropriate.

# Configuration

FIXME: ports etc.

### Generate an OpenSSL Certificate

FIXME:

Run this command:

    $ openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /opt/local/etc/server.pem -out /opt/local/etc/server.pem \
        -subj "/C=US/ST=CA/O=Joyent/OU=manta/CN=localhost"

## Load Balancer

The loadbalancer used is [HAProxy](http://www.haproxy.org/).  There is an
`haproxy.cfg.in` file that is templated with a sparse number of `%s`; this file
is used to generate a new haproxy.cfg each time the topology of online
loadbalancers changes.

*Important:* Checked into this repo is a "blank" haproxy.cfg.default - *DO NOT
EDIT THIS FILE!*, except in the case you need the default behaviour to change.
That file is used as a syntactically correct, but empty haproxy.cfg file that we
use to bootstrap haproxy _before_ muppet is running.  Any changes you want to
see made to haproxy.cfg must be made in the template file, as that's what you
really care about.

## Muppet

*name* is really the important variable here, as that dictates the path in
ZooKeeper to watch (note the DNS name is reversed and turned into a `/`
separated path); entries should have been written there by `registrar`.

    {
        "name": "manta.bh1-kvm1.joyent.us",
        "srvce": "_http",
        "proto": "_tcp",
        "port": 80,
        "zookeeper": {
            "servers": [ {
                "host": "10.2.201.66",
                "port": 2181
            } ],
            "timeout": 1000
        }
    }
