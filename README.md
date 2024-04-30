<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
    Copyright 2024 MNX Cloud, Inc.
-->

# muppet

This repository is part of the Triton and Manta projects.
For contribution guidelines, issues, and general documentation, visit the main
[Triton](http://github.com/TritonDataCenter/triton) and
[Manta](http://github.com/TritonDataCenter/manta) project pages.

Muppet is an HTTP loadbalancer (haproxy) and small daemon that interacts with
ZooKeeper via [registrar](https://github.com/TritonDataCenter/registrar).  The
muppet daemon will update the loadbalancer as backend servers come and go.

See the [documentation](https://github.com/TritonDataCenter/muppet/docs/index.md)
for more details.

## Active Branches

There are currently two active branches of this repository, for the two
active major versions of Manta. See the [mantav2 overview
document](https://github.com/TritonDataCenter/manta/blob/master/docs/mantav2.md)
for details on major Manta versions.

- [`master`](../../tree/master/) - For development of mantav2, the latest
  version of Manta. This is the version used by Triton.
- [`mantav1`](../../tree/mantav1/) - For development of mantav1, the long
  term support maintenance version of Manta.

# Development

Run `make prepush` before commits; otherwise, follow the
[Joyent Engineering Guidelines](https://github.com/TritonDataCenter/eng).

# Testing

Run `make test` - you don't need to be privileged. The locally built haproxy is
used as part of these tests: it expects to be able to use `/tmp/haproxy` as its
control socket, and it will try to connect to certain local ports.
