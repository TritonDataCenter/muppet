#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2014 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
SVC_ROOT=/opt/smartdc/muppet

source ${DIR}/shared.sh

export PATH=$SVC_ROOT/bin:$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH



# Mainline

# Log rotation and service imports were done at setup time. The only thing
# to do on reboot is ensure config-agent comes up correctly, and set TCP
# tunables.
set_sdc_resolver
set_tcp_tunables

exit 0
