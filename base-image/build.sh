#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'

mkdir -p $BUILD_DIR
cp -r $SOURCE_DIR/* $BUILD_DIR/
cd $BUILD_DIR
sed -i "s#.*DL_DIR ?=.*#DL_DIR ?= \"$SHARED_DOWNLOADS\"#g" build/conf/local.conf
sed -i "s#.*SSTATE_DIR ?=.*#SSTATE_DIR ?= \"$SHARED_SSTATE\"#g" build/conf/local.conf
useradd -m builder
chown builder -R $BUILD_DIR $DEST_DIR $SHARED_DOWNLOADS $SHARED_SSTATE
sudo -H -u builder /bin/bash -c "cd $BUILD_DIR \
	&& source oe-core/oe-init-build-env build bitbake \
	&& MACHINE=$TARGET_MACHINE $BUILD_DIR/bitbake/bin/bitbake core-image-minimal && pwd"
cp --dereference $BUILD_DIR/build/tmp-glibc/deploy/images/$TARGET_MACHINE/core-image-minimal-$TARGET_MACHINE.tar.gz  $DEST_DIR/rootfs.tar.gz
