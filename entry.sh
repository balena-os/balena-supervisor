#!/bin/sh

set -o errexit

# Start Avahi to allow MDNS lookups and remove
# any pre-defined services
rm -f /etc/avahi/services/*
mkdir -p /var/run/dbus
rm -f /var/run/avahi-daemon/pid
rm -f /var/run/dbus/pid
if [ -x /etc/init.d/dbus-1 ]; then
	/etc/init.d/dbus-1 start;
elif [ -x /etc/init.d/dbus ]; then
	/etc/init.d/dbus start;
else
	echo "Could not start container local dbus daemon. Avahi services may fail!";
fi;
/etc/init.d/avahi-daemon start

# If the legacy /tmp/resin-supervisor exists on the host, a container might
# already be using to take an update lock, so we symlink it to the new
# location so that the supervisor can see it
[ -d /mnt/root/tmp/resin-supervisor ] &&
    ( [ -d /mnt/root/tmp/balena-supervisor ] || ln -s ./resin-supervisor /mnt/root/tmp/balena-supervisor )

# Otherwise, if the lockfiles directory doesn't exist
[ -d /mnt/root/tmp/balena-supervisor ] ||
    mkdir -p /mnt/root/tmp/balena-supervisor

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

# Mount the host kernel module path onto the expected location
# We need to do this as busybox doesn't support using a custom location
if [ ! -d /lib/modules ]; then
	ln -s /mnt/root/lib/modules /lib/modules
fi
# Now load the ip6_tables kernel module, so we can do
# filtering on ipv6 addresses. Don't fail here if the
# modprobe fails, as this can either be that the module is
# already loaded or that the kernel module isn't present. In
# the former case, this is fine for runtime, and in the
# latter it means that the supervisor will fail later on, so
# not a problem.
modprobe ip6_tables || true

exec node /usr/src/app/dist/app.js
