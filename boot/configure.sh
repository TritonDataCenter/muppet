#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

#
# Before we get going, jack our receive and transmit windows as well as our
# maximum number of incoming connections
#
echo "Setting TCP tunables"
ipadm set-prop -t -p max_buf=2097152 tcp
ndd -set /dev/tcp tcp_recv_hiwat 2097152
ndd -set /dev/tcp tcp_xmit_hiwat 2097152

exit 0
