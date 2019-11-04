<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# buckets branch

Fixes:

MANTA-3680 loadbalancer stud processes are not evenly utilized
MANTA-1424 stud not restarted when SSL certificate changes
MANTA-3252 use haproxy SSL termination for loadbalancer
MANTA-4615 Front door load balancing for buckets
MANTA-3526 want to disable tls 1.0

Remaining TODO:

 - some proper perf QA qualification
 - figure out O(children processes) settings: do we need production value
   set via boot/setup.sh?
 - enabled cipher list: sufficient? do we need older ones?
   (check against scloud JDK using
    https://github.com/joyent/java-manta/blob/master/USAGE.md#enabling-libnss-support-via-pkcs11)
 - re-verify grading against RFD93 tools: https://ssldecoder.org/,
   https://www.ssllabs.com/ssltest/analyze.html, https://cipherli.st/
 - all clients OK now with header case insensitivity?
 - fix/verify cmd/manta-replace-cert.js 
 - should muppet now depend on config-agent?
 - need to fix RSS alarm for new setup?

# muppet

This repository is part of the Joyent SmartDataCenter project (SDC), and the
Joyent Manta project.  For contribution guidelines, issues, and general
documentation, visit the main [SDC](http://github.com/joyent/sdc) and
[Manta](http://github.com/joyent/manta) project pages.

Muppet is an HTTP loadbalancer (haproxy) and small daemon that interacts with
ZooKeeper via [registrar](https://github.com/joyent/registrar).  The muppet
daemon will update the loadbalancer as backend servers come and go.

See the [documentation](https://github.com/joyent/muppet/docs/index.md) for
more details.

# Development

Run `make prepush` before commits; otherwise, follow the
[Joyent Engineering Guidelines](https://github.com/joyent/eng).

# Testing

Run `make test` - you don't need to be privileged. The locally built haproxy is
used as part of these tests: it expects to be able to use `/tmp/haproxy` as its
control socket, and it will try to connect to certain local ports.
