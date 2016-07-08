#!/bin/bash

set -o errexit
set -o pipefail

date=$(date +'%Y%m%d' -u)
JENKINS_PERSISTENT_WORKDIR=${1:-/var/lib/yocto}
DL_DIR="$JENKINS_PERSISTENT_WORKDIR/shared-downloads"
# MACHINE_LIST: generic-x86-64 generic-x86 generic-armv6 generic-armv7hf generic-armv5
# MACHINE_LIST should be set in jenkins config

git submodule update --init --recursive
rm -rf dest
mkdir dest

docker build -t supervisor-base-builder .
for machine in $MACHINE_LIST; do
	case "$machine" in
	'generic-x86-64')
		REPO='resin/amd64-supervisor-base'
	;;
	'generic-x86')
		REPO='resin/i386-supervisor-base'
	;;
	'generic-armv6')
		REPO='resin/rpi-supervisor-base'
	;;
	'generic-armv7hf')
		REPO='resin/armv7hf-supervisor-base'
	;;
	'generic-armv5')
		REPO='resin/armel-supervisor-base'
	;;
	esac
	SSTATE_DIR="$JENKINS_PERSISTENT_WORKDIR/$machine/sstate"
	# Make sure shared directories are in place
	mkdir -p $DL_DIR
	mkdir -p $SSTATE_DIR

	docker run --rm \
		-e TARGET_MACHINE=$machine \
		-e BUILDER_UID=$(id -u) \
		-e BUILDER_GID=$(id -g) \
		-v `pwd`:/source \
		-v $DL_DIR:/yocto/shared-downloads \
		-v $SSTATE_DIR:/yocto/shared-sstate \
		-v `pwd`/dest:/dest \
		supervisor-base-builder
	if [ -f dest/rootfs.tar.gz ]; then
		docker import dest/rootfs.tar.gz $REPO:$date
		docker tag -f $REPO:$date $REPO:latest
		docker push $REPO
	else
		echo "rootfs is missing!"
		exit 1
	fi
done
