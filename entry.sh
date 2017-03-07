#!/bin/sh

set -o errexit

[ -d /dev/net ] ||
    mkdir -p /dev/net
[ -c /dev/net/tun ] ||
    mknod /dev/net/tun c 10 200
[ -d /mnt/root/tmp/resin-supervisor ] ||
    mkdir -p /mnt/root/tmp/resin-supervisor

mount -t tmpfs -o size=1m tmpfs /var/run/resin

# If DOCKER_ROOT isn't set then default it
if [ -z "${DOCKER_ROOT}" ]; then
	DOCKER_ROOT=/mnt/root/var/lib/rce
fi

# Mount the DOCKER_ROOT path equivalent in the container fs
DOCKER_LIB_PATH=${DOCKER_ROOT#/mnt/root}

if [ ! -d "${DOCKER_LIB_PATH}" ]; then
	ln -s "${DOCKER_ROOT}" "${DOCKER_LIB_PATH}"
fi
