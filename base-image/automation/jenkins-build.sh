#!/bin/bash

set -o errexit
set -o pipefail

# ARCH, ESCAPED_BRANCH_NAME, BASE_IMAGE_REPO and BASE_IMAGE_TAG should be set before calling this script.
# This script purposefully doesn't clean up the BASE_IMAGE_TAG docker image after building it.

JENKINS_PERSISTENT_WORKDIR=${1:-/var/lib/yocto}
DL_DIR="$JENKINS_PERSISTENT_WORKDIR/shared-downloads"
mkdir dest

BUILDER_REPO=registry.resinstaging.io/resin/${ARCH}-supervisor-base-builder
BUILDER_IMAGE=${BUILDER_REPO}:${ESCAPED_BRANCH_NAME}

docker pull ${BUILDER_IMAGE} || docker pull ${BUILDER_REPO}:master || true
docker build -t ${BUILDER_IMAGE} .
docker push ${BUILDER_IMAGE} || true

case "$ARCH" in
'amd64')
	machine='generic-x86-64'
;;
'i386')
	machine='generic-x86'
;;
'rpi')
	machine='generic-armv6'
;;
'armv7hf')
	machine='generic-armv7hf'
;;
'armel')
	machine='generic-armv5'
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
	${BUILDER_IMAGE}
docker rmi -f $(docker inspect -f "{{.Id}}" ${BUILDER_IMAGE}) || true
if [ -f dest/rootfs.tar.gz ]; then
	docker import dest/rootfs.tar.gz ${BASE_IMAGE_TAG}
	docker tag ${BASE_IMAGE_TAG} ${BASE_IMAGE_REPO}:${ESCAPED_BRANCH_NAME} || docker tag -f ${BASE_IMAGE_TAG} ${BASE_IMAGE_REPO}:${ESCAPED_BRANCH_NAME}
	docker push ${BASE_IMAGE_TAG}
else
	echo "rootfs is missing!"
	exit 1
fi
