#
# Copyright (c) 2014 Joyent Inc., All rights reserved.
#
# Functions shared between setup.sh and configure.sh
#


#
# Load the fatal function:
#
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
source ${DIR}/scripts/util.sh

function find_sdc_resolver {
    local sapi_url

    if [[ -n $(mdata-get sdc:tags.manta_role) ]]; then
        sapi_url=$(mdata-get SAPI_URL)
    else
        # Get SAPI_SERVICE from SAPI itself
        source /opt/smartdc/boot/lib/util.sh
        sapi_url=$(sapi_get /configs/$(zonename) | json metadata.SAPI_SERVICE)
    fi

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
function set_sdc_resolver {
    find_sdc_resolver
    cat /etc/resolv.conf | grep -v nameserver > /tmp/resolv.conf
    echo "nameserver $SDC_RESOLVER" >> /tmp/resolv.conf
    mv /tmp/resolv.conf /etc/resolv.conf
}


#
# Jack our receive and transmit windows as well as our maximum number of
# incoming connections
#
function set_tcp_tunables {
    echo "Setting TCP tunables"
    ipadm set-prop -t -p max_buf=2097152 tcp
    ndd -set /dev/tcp tcp_recv_hiwat 2097152
    ndd -set /dev/tcp tcp_xmit_hiwat 2097152
    ndd -set /dev/tcp tcp_conn_req_max_q 2048
    ndd -set /dev/tcp tcp_conn_req_max_q0 8192
}
