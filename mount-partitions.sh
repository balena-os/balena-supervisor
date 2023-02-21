#!/bin/sh

# Mounts boot, state, & data partitions from balenaOS.
# The container must be privileged for this to function correctly.

# Get the current boot block device in case there are duplicate partition labels
# for `(balena|resin)-(boot|state|data)` found.
current_boot_block_device=""
if [ "${TEST}" != 1 ]; then
    current_boot_partition=$(fdisk -l | grep '*  ' | cut -d' ' -f1 2>&1)
    current_boot_block_device=$(lsblk -no pkname "${current_boot_partition}")
    if [ "${current_boot_block_device}" = "" ]; then
        echo "ERROR: Could not determine boot device. Please launch Supervisor as a privileged container with host networking."
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
        mount "${device}" "${mount_path}"
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

    # Get one or more devices matching label, accounting for legacy partition labels.
    device=$(blkid | grep -E "(resin|balena)-${partition_label}" | awk -F':' '{print $1}')
    
    # If multiple devices with the partition label are found, mount to the device
    # that's part of the current boot device, as this indicates a duplicate 
    # label somewhere created by a user or an inconsistency in the system.
    # We've been able to identify the current boot device, so use that
    # to find the device with the correct label amongst 2+ devices.
    for d in ${device}; do
        if [ "$(echo "$d" | grep "$current_boot_block_device")" != "" ]; then
            echo "INFO: Found device $d on current boot device $current_boot_block_device, using as mount for '(resin|balena)-${partition_label}'."
            do_mount "${d}" "${target_path}"
            return 0
        fi
    done

    # If no devices were found, use legacy mountpoints.
    echo "ERROR: Could not determine which partition to mount for label '(resin|balena)-${partition_label}'. Please make sure the Supervisor is running on a balenaOS device."
    exit 1
}

# Set overlayfs root mountpoint
export ROOT_MOUNTPOINT="/mnt/root"

# Set boot mountpoint
BOOT_MOUNTPOINT="/mnt/boot"
setup_then_mount "boot" "${BOOT_MOUNTPOINT}"
export BOOT_MOUNTPOINT

# Read from the os-release of boot partition instead of overlay
export HOST_OS_VERSION_PATH="${BOOT_MOUNTPOINT}/os-release"

# CONFIG_MOUNT_POINT is set to /boot/config.json in Dockerfile.template,
# but that's a legacy mount provided by host and we should override it.
export CONFIG_MOUNT_POINT="${BOOT_MOUNTPOINT}/config.json"
