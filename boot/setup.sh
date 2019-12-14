#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2019 Joyent, Inc.
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

#
# This is an arbitrary value
#
METRICS_PORT=9090

function manta_setup_muppet {
    local metrics_port=${METRICS_PORT}
    local muppet_smf_xml_manifest_in="${SVC_ROOT}/smf/manifests/muppet.xml.in"
    local muppet_smf_xml_manifest_out="${SVC_ROOT}/smf/manifests/muppet.xml"

    sed -e "s#@@MUPPET-METRICS_PORT@@#$metrics_port#g" \
        ${muppet_smf_xml_manifest_in} > ${muppet_smf_xml_manifest_out} || \
        fatal "Could not process ${muppet_smf_xml_manifest_in} to ${muppet_smf_xml_manifest_out}"

    svccfg import ${muppet_smf_xml_manifest_out} || \
        fatal "Could not import: ${muppet_smf_xml_manifest_out}"

    svcadm enable muppet || \
        fatal "Unable to start muppet"

    mdata-put metricPorts ${metrics_port}
}


function manta_setup_haproxy {
    # Clean up the old syslog
    rm -f /etc/syslog.conf

    # Tack in what we need to rsyslog
    echo 'local0.*  /var/log/haproxy.log;bunyan' >> /etc/rsyslog.conf

    svcadm restart system-log
    [[ $? -eq 0 ]] || fatal "Unable to restart rsyslog"

    manta_add_logadm_entry "haproxy" "/var/log"
    svccfg import $SVC_ROOT/smf/manifests/haproxy.xml

    cp $SVC_ROOT/etc/haproxy.cfg.default $SVC_ROOT/etc/haproxy.cfg

    svcadm enable haproxy
    [[ $? -eq 0 ]] || fatal "Unable to start haproxy"
}


# Mainline

echo "Running common setup scripts"
manta_common_presetup

echo "Adding local manifest directories"
manta_add_manifest_dir "/opt/smartdc/muppet"

manta_common_setup "muppet"

manta_ensure_zk

echo "Setting up registrar"
manta_setup_registrar

echo "Setting up haproxy"
manta_setup_haproxy

echo "Updating muppet configuration"
manta_setup_muppet

manta_common_setup_end

exit 0
