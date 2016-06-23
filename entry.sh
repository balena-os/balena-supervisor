#!/bin/sh

set -e

[ -d /dev/net ] ||
    mkdir -p /dev/net
[ -c /dev/net/tun ] ||
    mknod /dev/net/tun c 10 200

cd /app

mkdir -p /var/log/supervisor && touch /var/log/supervisor/supervisord.log
mkdir -p /var/run/resin
mount -t tmpfs -o size=1m tmpfs /var/run/resin

if [ -z "$GOSUPER_SOCKET" ]; then
	export GOSUPER_SOCKET=/var/run/resin/gosuper.sock
fi
if [ -z "$DOCKER_SOCKET" ]; then
	export DOCKER_SOCKET=/run/docker.sock
fi
if [ -z "$HOST_PROC" ]; then
	export HOST_PROC=/mnt/root/proc
fi

export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket"

# If DOCKER_ROOT isn't set then default it
if [ -n "${DOCKER_ROOT}" ]; then
	DOCKER_ROOT=/mnt/root/var/lib/docker
fi
# If docker data directory isn't mounted in the default path, symlink it
if [ ! -d /var/lib/docker ]; then
	ln -s "${DOCKER_ROOT}" /var/lib/docker
fi
# And also mount the DOCKER_ROOT path equivalent in the container fs
DOCKER_LIB_PATH=${DOCKER_ROOT#/mnt/root}
if [ ! -d /var/lib/docker ]; then
	ln -s "${DOCKER_ROOT}" "${DOCKER_LIB_PATH}" || true
fi

/usr/bin/supervisord -c /etc/supervisor/supervisord.conf

supervisorctl start resin-supervisor
supervisorctl start go-supervisor

tail -F \
	/var/log/supervisor/supervisord.log \
	/var/log/resin_supervisor_stdout.log
