<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2019, Joyent, Inc.
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

## Prerequisites

To properly run the muppet tests, the following package must be installed from
pkgsrc:

- haproxy

Though the version of haproxy might differ from the running `loadbalancer` zone,
it is used to check that haproxy can properly parse the resulting
`haproxy.cfg` files generated in the tests.

## Running the Tests

Then to run the tests, run `make test`
