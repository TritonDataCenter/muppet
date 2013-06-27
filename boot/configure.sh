#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-

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

    svccfg import /opt/local/share/smf/stud/manifest.xml
    svcadm enable stud
    [[ $? -eq 0 ]] || fatal "Unable to start stud"
}



# Mainline

#
# Since the external network is the primary network for this zone, the Google
# DNS servers (8.8.8.8/8.8.4.4) will be first in the list of resolvers.  As this
# zone is setting up, the config-agent can't resolve the SAPI hostname (e.g.
# sapi.bh1-kvm6.joyent.us) and zone setup will fail.
#
# Here, remove the external DNS servers so this zone's setup can finish
# appropriately.  As part of setup, the config-agent will rewrite the
# /etc/resolv.conf file with the proper resolvers, so this hack just allows that
# agent to discover and download the appropriate zone configuration.
#
cat /etc/resolv.conf | grep -v 8.8.8.8 | grep -v 8.8.4.4 > /tmp/resolv.conf
mv /tmp/resolv.conf /etc/resolv.conf

echo "Running common setup scripts"
manta_common_presetup

#
# Before we get going, jack our receive and transmit windows as well as our
# maximum number of incoming connections
#
echo "Setting TCP tunables"
ndd -set /dev/tcp tcp_recv_hiwat 2097152
ndd -set /dev/tcp tcp_xmit_hiwat 2097152

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
