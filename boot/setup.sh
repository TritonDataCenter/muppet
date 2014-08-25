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

set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
SVC_ROOT=/opt/smartdc/muppet

source ${DIR}/scripts/util.sh
source ${DIR}/scripts/services.sh

export PATH=$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH

MUPPET_CFG=$SVC_ROOT/etc/config.json


function find_sdc_resolver {
    local sapi_url=$(mdata-get SAPI_URL)
    if [[ -z $sapi_url ]]; then
        fatal "Unable to get SAPI_URL"
    fi
    local sapi_hostname=$(basename $sapi_url)
    if [[ -z $sapi_hostname ]] || [[ $sapi_hostname != *sapi* ]]; then
        fatal "$sapi_hostname isn't recognizable as sapi"
    fi
    SDC_RESOLVER=''
    local resolvers=$(cat /etc/resolv.conf | grep nameserver | \
        cut -d ' ' -f 2 | tr '\n' ' ')
    for resolver in $resolvers; do
        local sapi_ip;
        sapi_ip=$(dig @$resolver $sapi_hostname +short)
        if [[ $? != 0 ]]; then
            echo "$resolver was unavailable to resolve $sapi_hostname"
            continue
        fi
        if [[ -n "$sapi_ip" ]]; then
            SDC_RESOLVER="$resolver"
            break
        else
            echo "$resolver did not resolve $sapi_hostname"
        fi
    done
    if [[ -z "$SDC_RESOLVER" ]]; then
        fatal "No resolvers were able to resolve $sapi_hostname"
    fi
}


function manta_setup_muppet {
    svccfg import /opt/smartdc/muppet/smf/manifests/muppet.xml
    svcadm enable muppet
    [[ $? -eq 0 ]] || fatal "Unable to start muppet"
}


function manta_setup_haproxy {
    # Clean up the old syslog
    rm -f /etc/syslog.conf

    # Tack in what we need to rsyslog
    echo 'local0.*  /var/log/haproxy.log' >> /etc/rsyslog.conf

    svcadm restart system-log
    [[ $? -eq 0 ]] || fatal "Unable to restart rsyslog"

    manta_add_logadm_entry "haproxy" "/var/log"
    svccfg import $SVC_ROOT/smf/manifests/haproxy.xml

    cp $SVC_ROOT/etc/haproxy.cfg.default $SVC_ROOT/etc/haproxy.cfg

    svcadm enable haproxy
    [[ $? -eq 0 ]] || fatal "Unable to start haproxy"
}


function manta_setup_stud {
    manta_add_logadm_entry "stud"

    svccfg import $SVC_ROOT/smf/manifests/stud.xml
    svcadm enable stud
    [[ $? -eq 0 ]] || fatal "Unable to start stud"
}



# Mainline

#
# Since the external network is the primary network for this zone, external DNS
# servers will be first in the list of resolvers.  As this zone is setting up,
# the config-agent can't resolve the SAPI hostname (e.g.  sapi.coal.joyent.us)
# and zone setup will fail.
#
# Here, remove all resolvers but the SDC resolver so setup can finish
# appropriately.  As part of setup, the config-agent will rewrite the
# /etc/resolv.conf file with the proper resolvers, so this just allows that
# agent to discover and download the appropriate zone configuration.
#
find_sdc_resolver
cat /etc/resolv.conf | grep -v nameserver > /tmp/resolv.conf
echo "nameserver $SDC_RESOLVER" >> /tmp/resolv.conf
mv /tmp/resolv.conf /etc/resolv.conf

echo "Running common setup scripts"
manta_common_presetup

echo "Adding local manifest directories"
manta_add_manifest_dir "/opt/smartdc/muppet"

manta_common_setup "muppet"

manta_ensure_zk

echo "Setting up registrar"
manta_setup_registrar

echo "Setting up stud"
manta_setup_stud

echo "Setting up haproxy"
manta_setup_haproxy

echo "Updating muppet configuration"
manta_setup_muppet

manta_common_setup_end

exit 0
