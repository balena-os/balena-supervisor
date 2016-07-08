#!/bin/bash

set -o errexit
set -o pipefail

date=$(date +'%Y%m%d' -u)
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
		REPO='resin/armv6-supervisor-base'
	;;
	'generic-armv7hf')
		REPO='resin/armv7hf-supervisor-base'
	;;
	'generic-armv5')
		REPO='resin/armel-supervisor-base'
	;;
	esac
	docker run --rm \
		-e TARGET_MACHINE=$machine \
		-v `pwd`:/source \
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
