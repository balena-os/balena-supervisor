#!/bin/sh

set -a

# read key from <key>="<value>" config file
read_config() {
  sed -n "s/^$1=\"\(.*\)\"$/\1/p" $2 2>/dev/null
}

# apply filter to json file and return raw output
# return default if the filter does not exist
read_json() {
  [ "$(jq -r $1 $2 2>/dev/null)" != "null" ] && jq -r $1 $2 || echo -n $3
}

# Setup paths
ROOT_MOUNTPOINT=${ROOT_MOUNTPOINT:-/mnt/root}
BOOT_MOUNTPOINT=${BOOT_MOUNTPOINT:-/mnt/boot}

# Useful short aliases
_root=${ROOT_MOUNTPOINT}
_boot=${ROOT_MOUNTPOINT}${BOOT_MOUNTPOINT}
_data=${ROOT_MOUNTPOINT}/mnt/data

# Config mountpoint is still used by migrations
CONFIG_MOUNT_POINT=${CONFIG_MOUNT_POINT:-${_boot}/config.json}
APPS_JSON_PATH=${APPS_JSON_PATH:-${_data}/apps.json}
DATABASE_PATH=${_data}/resin-data/balena-supervisor/database.sqlite

# Set docker configuration
DOCKER_SOCKET=${DOCKER_SOCKET:-${ROOT_MOUNTPOINT}/var/run/balena-engine.sock}
DOCKER_HOST=${DOCKER_HOST:-unix://${DOCKER_SOCKET}}

# Dbus socket
DBUS_SYSTEM_BUS_ADDRESS="unix:path=${ROOT_MOUNTPOINT}/run/dbus/system_bus_socket"

# Use a trick to get the container id from inside the container itself in
# in case the supervisor is started some other way than with the start-resin-supervisor
# script. This will not work with cgrous v2
# https://stackoverflow.com/a/25729598
if [ -z "${SUPERVISOR_CONTAINER_ID}" ]; then
	SUPERVISOR_CONTAINER_ID=$(cat /proc/self/cgroup | grep -o  -e "docker-.*.scope" | head -n 1 | sed "s/docker-\(.*\).scope/\\1/")
fi

# Supervisor environment variables
SUPERVISOR_VERSION=$(read_json .version package.json -n)
SUPERVISOR_IMAGE=${SUPERVISOR_IMAGE:-$(curl -XGET --unix-socket "${DOCKER_SOCKET}" \
  "http://localhost/containers/${SUPERVISOR_CONTAINER_ID}/json" | jq -r .Image 2>/dev/null \
  || echo -n "balena/${SUPERVISOR_ARCH}-supervisor")}

# Container service variables
BALENA_DEVICE_TYPE=${BALENA_DEVICE_TYPE:-$(read_json .slug ${_boot}/device-type.json)}
BALENA_DEVICE_ARCH=${BALENA_DEVICE_ARCH:-$(read_json .arch ${_boot}/device-type.json)}
BALENA_HOST_OS_VERSION=${BALENA_HOST_OS_VERSION:-$(read_config 'PRETTY_NAME' ${_root}/etc/os-release)}
BALENA_HOST_OS_META_RELEASE=$(read_config 'META_BALENA_VERSION' ${_root}/etc/os-release)
BALENA_HOST_OS_VARIANT=$(read_config 'VARIANT_ID' ${ROOTDIR}/etc/os-release)
if [ -n "$(read_json .developmentMode ${_boot}/config.json)" ]; then
  BALENA_HOST_OS_VARIANT=$([ "$(read_json .developmentMode ${_boot}/config.json )" = "true" ] && echo -n "dev" || echo -n "prod")
fi

# Other defaults
LED_FILE=${LED_FILE:-/dev/null}
LISTEN_PORT=${LISTEN_PORT:-$(read_json .listenPort ${_boot}/config.json 48484)}
