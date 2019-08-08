<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# muppet

This repository is part of the Joyent SmartDataCenter project (SDC), and the
Joyent Manta project.  For contribution guidelines, issues, and general
documentation, visit the main [SDC](http://github.com/joyent/sdc) and
[Manta](http://github.com/joyent/manta) project pages.

Muppet is an HTTP loadbalancer (haproxy) and small daemon that interacts with
ZooKeeper via registrar.  The muppet daemon will update the loadbalancer with
new configuration as hosts come and go from the given service name.

# Development

Run `make prepush` before commits; otherwise, follow the
[Joyent Engineering Guidelines](https://github.com/joyent/eng).

# Testing

Run `make test` - you don't need to be privileged. The locally built haproxy is
used as part of these tests: it expects to be able to use `/tmp/haproxy` as its
control socket, and it will try to connect to certain local ports.
