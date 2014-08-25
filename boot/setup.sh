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

role=muppet
SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
PROFILE=/root/.profile
SVC_ROOT=/opt/smartdc/muppet
ZONE_UUID=`/usr/bin/zonename`

export PATH=$SVC_ROOT/bin:$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH

#
# XXX in the future this should come from SAPI and we should be pulling out
# the "application" that's the parent of this instance. (see: SAPI-173)
#
if [[ -n $(mdata-get sdc:tags.manta_role) ]]; then
    export FLAVOR="manta"
else
    export FLAVOR="sdc"
fi

source ${DIR}/scripts/util.sh
source ${DIR}/scripts/services.sh
source ${DIR}/shared.sh


function gen_cert {
    mkdir -p /opt/smartdc/$role/ssl
    /opt/local/bin/openssl req -x509 -nodes -subj '/CN=*' -newkey rsa:2048 \
        -keyout /opt/smartdc/$role/ssl/key.pem \
        -out /opt/smartdc/$role/ssl/cert.pem -days 365

    cat /opt/smartdc/$role/ssl/cert.pem > /opt/smartdc/$role/etc/ssl.pem
    cat /opt/smartdc/$role/ssl/key.pem >> /opt/smartdc/$role/etc/ssl.pem
}


function setup_muppet {
    svccfg import /opt/smartdc/muppet/smf/manifests/muppet.xml
    svcadm enable muppet
    [[ $? -eq 0 ]] || fatal "Unable to start muppet"
}


function setup_haproxy {
    # Clean up the old syslog
    rm -f /etc/syslog.conf

    # Tack in what we need to rsyslog
    echo 'local0.*  /var/log/haproxy.log' >> /etc/rsyslog.conf

    svcadm restart system-log
    [[ $? -eq 0 ]] || fatal "Unable to restart rsyslog"

    svccfg import $SVC_ROOT/smf/manifests/haproxy.xml

    cp $SVC_ROOT/etc/haproxy.cfg.default $SVC_ROOT/etc/haproxy.cfg

    svcadm enable haproxy
    [[ $? -eq 0 ]] || fatal "Unable to start haproxy"
}


function setup_stud {
    svccfg import /opt/local/share/smf/stud/manifest.xml
    svcadm enable stud
    [[ $? -eq 0 ]] || fatal "Unable to start stud"
}



# Mainline

set_sdc_resolver
set_tcp_tunables

if [[ ${FLAVOR} == "manta" ]]; then
    rm -rf $SVC_ROOT/sdc/sapi_manifests

    echo "Running common setup scripts"
    manta_common_presetup

    echo "Adding local manifest directories"
    manta_add_manifest_dir "/opt/smartdc/muppet"

    manta_common_setup "muppet"

    manta_ensure_zk

    echo "Setting up registrar"
    manta_setup_registrar

    echo "Setting up stud"
    setup_stud
    manta_add_logadm_entry "stud"

    echo "Setting up haproxy"
    setup_haproxy
    manta_add_logadm_entry "haproxy" "/var/log"

    echo "Updating muppet configuration"
    setup_muppet

    manta_common_setup_end

else # ${FLAVOR} == "sdc"

    # Local manifests
    CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role/sdc

    # Cookie to identify this as a SmartDC zone and its role
    mkdir -p /var/smartdc/$role

    # Add build/node/bin and node_modules/.bin to PATH
    echo "" >>$PROFILE
    echo "export PATH=\$PATH:/opt/smartdc/$role/build/node/bin:/opt/smartdc/$role/node_modules/.bin:/opt/smartdc/$role/node_modules/$role/bin" >>$PROFILE

    # Include common utility functions (then run the boilerplate). This
    # includes registrar and config-agent setup.
    source /opt/smartdc/boot/lib/util.sh
    sdc_common_setup

    manta_ensure_zk

    echo "Generating SSL certificate"
    gen_cert

    echo "Setting up stud"
    setup_stud

    echo "Setting up haproxy"
    setup_haproxy
    # XXX: setup haproxy.log - bring in setup_moray_rsyslogd from moray

    echo "Updating muppet configuration"
    setup_muppet

    echo "Setting up log rotation"
    sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
    sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
    sdc_log_rotation_add registrar /var/svc/log/*registrar*.log 1g
    sdc_log_rotation_add stud /var/svc/log/*stud*.log 1g
    sdc_log_rotation_add haproxy /var/log/haproxy.log 1g
    sdc_log_rotation_add muppet /var/svc/log/*muppet*.log 1g
    sdc_log_rotation_setup_end

    # All done, run boilerplate end-of-setup
    sdc_setup_complete
fi

exit 0
