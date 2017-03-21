#!/bin/sh

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
if [ -z "${DOCKER_ROOT}" ]; then
	DOCKER_ROOT=/mnt/root/var/lib/rce
fi

# Enable full debug logging for Rust
export RUST_LOG=debug

exec $@
