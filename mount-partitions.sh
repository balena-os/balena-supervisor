#!/bin/sh

# Mounts boot, state, & data partitions from balenaOS.
# The container must be privileged for this to function correctly.

# Set overlayfs root mountpoint
export ROOT_MOUNTPOINT="/mnt/root"

# Set DBus system bus address for getting the current boot block device
export DBUS_SYSTEM_BUS_ADDRESS="${DBUS_SYSTEM_BUS_ADDRESS:-unix:path="${ROOT_MOUNTPOINT}"/run/dbus/system_bus_socket}"

# Get the block device from systemd
# The dbus-send command below should return something like:
# ```
# method return time=1680132905.878117 sender=:1.0 -> destination=:1.20155 serial=245193 reply_serial=2
#   variant       string "/dev/sda1"
# ```
# Usage: dbus_get_mount PARTITION
# Partition is only the label, e.g. boot, state, data
dbus_get_mount() {
    part="$1"
    result=$(dbus-send --system --print-reply \
        --dest=org.freedesktop.systemd1 /org/freedesktop/systemd1/unit/mnt_2d${part}_2emount org.freedesktop.DBus.Properties.Get \
        string:"org.freedesktop.systemd1.Mount" string:"What" | grep "string" | cut -d'"' -f2 2>&1)
    # If the output doesn't match the /dev/* device regex, return empty and do not exit
    if [ "$(echo "${result}" | grep -E '^/dev/')" = "" ]; then
        echo ""
    else
        echo "${result}"
    fi
}

# Identify an encrypted partition using dmsetup
# Works for both dm-crypt and LUKS encrypted partitions
# Arguments:
# 1: Partition device - will be converted to a DM device
# Returns:
# 0: The partition device is encrypted
# 1: The partition device is not encrypted
is_part_encrypted() {
	_part="${1#/dev/}"
	_dm_part="${_part}"
	if command -v dmsetup > /dev/null; then
		if [ "${_part#dm-}" = "${_part}" ]; then
			# Does not start with dm-
			if [ "${_part#mapper/}" = "${_part}" ]; then
				# Does not start with mapper/
				# Find the corresponding DM device to the partition
				_dm_part=$(lsblk -nlo kname "/dev/${_dm_part}" | grep dm)
				if [ -z "${_dm_part}" ]; then
					# No corresponding DM device, no dm-crypt in use
					return 1
				fi
			fi
		fi
		# _dm_part is a DM device, either dm* or mapper/*
		_name=$(lsblk -nlo name "/dev/${_dm_part}")
		if dmsetup ls --target crypt | grep -q "${_name}"; then
			return 0
		fi
	fi
	return 1
}

# Make sure dm-crypt devices are active in the container
dmsetup_part() {
    _label="${1}"
    if _dmname=$(dmsetup ls --target crypt | grep "${_label}" | awk '{print $1}'); then
        # LUKS DM devices are not named after the partition label
        # so no need to check for LUKS explicitely
        if [ -n "${_dmname}" ]; then
            dmsetup resume "${_dmname}"
        fi
    fi
}

# Get the current boot block device in case there are duplicate partition labels
# for `(balena|resin)-(boot|state|data)` found.
secure_boot_partitions='efi rpi imx'
current_boot_block_device=""
if [ "${TEST}" != 1 ]; then
    mnt_boot_dev=$(dbus_get_mount "boot")
    dmsetup_part "boot"
    if is_part_encrypted "${mnt_boot_dev}"; then
        echo "INFO: Encrypted boot partition detected."
        for part in $secure_boot_partitions; do
            echo "INFO: Trying ${part} as boot partition."
            boot_part=$(dbus_get_mount "${part}")
            if [ -n "${boot_part}" ]; then
                echo "INFO: Using ${part} as boot partition."
                break
            else
                echo "ERROR: Could not determine ${part} device from dbus."
            fi
        done
    else
        boot_part="${mnt_boot_dev}"
    fi

    if [ -z "${boot_part}" ]; then
        echo "ERROR: Could not determine boot device from dbus. Please launch Supervisor as a privileged container with DBus socket access."
        exit 1
    fi

    current_boot_block_device=$(lsblk -no pkname "${boot_part}")
    if [ -z "${current_boot_block_device}" ]; then
        echo "ERROR: Could not determine boot device from lsblk. Please launch Supervisor as a privileged container."
        exit 1
    fi
fi


# Mounts a device to a path if it's not already mounted.
# Usage: do_mount DEVICE MOUNT_PATH
do_mount() {
    device=$1
    mount_path=$2

    # Create the directory if it doesn't exist
    mkdir -p "${mount_path}"

    # Mount the device if it doesn't exist
    if [ "$(mountpoint -n "${mount_path}" | awk '{ print $1 }')" != "${device}" ]; then
        fs_type=$(lsblk -nlo fstype "${device}")
        mount -t "${fs_type}" "${device}" "${mount_path}"
    fi
}

# Find the devices for each balenaOS partition.
# Usage: setup_then_mount PARTITION MOUNT_PATH
# PARTITION should be one of boot, state, or data. 
setup_then_mount() {
    # If in test environment, pretend we've succeeded at mounting everything to their
    # new mountpoints. We don't want to actually mount in a containerized test environment 
    # where the Supervisor is probably not running on a host that has the needed partitions.
    if [ "${TEST}" = 1 ]; then
        return 0
    fi

    partition_label=$1
    target_path=$2

    dmsetup_part "${partition_label}"

    # Try FS label first and partition label as a fallback
    for arg in label partlabel; do
        kname=$(lsblk "/dev/${current_boot_block_device}" -nlo "kname,${arg}" | grep -E "(resin|balena)-${partition_label}" | awk '{print $1}')
        device="/dev/${kname}"
        if [ -b "${device}" ]; then
            echo "INFO: Found device $device on current boot device $current_boot_block_device, using as mount for '(resin|balena)-${partition_label}'."
            do_mount "${device}" "${target_path}"
            return 0
        fi
    done

    # If no devices were found, use legacy mountpoints.
    echo "ERROR: Could not determine which partition to mount for label '(resin|balena)-${partition_label}'. Please make sure the Supervisor is running on a balenaOS device."
    exit 1
}

# Set boot mountpoint
BOOT_MOUNTPOINT="/mnt/boot"
setup_then_mount "boot" "${BOOT_MOUNTPOINT}"
export BOOT_MOUNTPOINT

# Read from the os-release of boot partition instead of overlay
#
# TODO: We need to remove the dependence on /mnt/root for this particular file.
# Reading from /mnt/boot/os-release is not always accurate, so we need to work
# with the OS team to find a better way to get the OS version.
export HOST_OS_VERSION_PATH="/mnt/root/etc/os-release"

# CONFIG_MOUNT_POINT is set to /boot/config.json in Dockerfile.template,
# but that's a legacy mount provided by host and we should override it.
export CONFIG_MOUNT_POINT="${BOOT_MOUNTPOINT}/config.json"

# Set state mountpoint
STATE_MOUNTPOINT="/mnt/state"
setup_then_mount "state" "${STATE_MOUNTPOINT}"
export STATE_MOUNTPOINT

# Set data mountpoint
DATA_MOUNTPOINT="/mnt/data"
setup_then_mount "data" "${DATA_MOUNTPOINT}"
export DATA_MOUNTPOINT

# Mount the Supervisor database directory to a more accessible & backwards compatible location.
# TODO: DB should be moved to a managed volume and mounted to /data in-container.
# Handle the case of such a Supervisor volume already existing.
# NOTE: After this PR, it should be good to remove the OS's /data/database.sqlite mount.
if [ ! -f /data/database.sqlite ] && [ "${TEST}" != 1 ]; then
    mkdir -p "${DATA_MOUNTPOINT}/resin-data/balena-supervisor"
    mount -o bind,shared "${DATA_MOUNTPOINT}"/resin-data/balena-supervisor /data
fi
export DATABASE_PATH="/data/database.sqlite"
