#!/bin/sh

set -o errexit

[ -d /mnt/root/tmp/resin-supervisor ] ||
    mkdir -p /mnt/root/tmp/resin-supervisor

# If DOCKER_ROOT isn't set then default it
if [ -z "${DOCKER_ROOT}" ]; then
	DOCKER_ROOT=/mnt/root/var/lib/rce
fi

# Mount the DOCKER_ROOT path equivalent in the container fs
DOCKER_LIB_PATH=${DOCKER_ROOT#/mnt/root}

if [ ! -d "${DOCKER_LIB_PATH}" ]; then
	ln -s "${DOCKER_ROOT}" "${DOCKER_LIB_PATH}"
fi

if [ -z "$DOCKER_SOCKET" ]; then
	export DOCKER_SOCKET=/run/docker.sock
fi

export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket"

# Include self-signed CAs, should they exist
if [ ! -z "${BALENA_ROOT_CA}" ]; then
	if [ ! -e '/etc/ssl/certs/balenaRootCA.pem' ]; then
		mkdir -p /usr/local/share/ca-certificates
		echo "${BALENA_ROOT_CA}" > /usr/local/share/ca-certificates/balenaRootCA.crt
		update-ca-certificates
	fi
fi

exec node /usr/src/app/dist/app.js
