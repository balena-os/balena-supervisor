#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'
groupadd -g $BUILDER_GID builder
useradd -m -u $BUILDER_UID -g $BUILDER_GID builder
sudo -H -u builder /bin/bash -c "mkdir -p $BUILD_DIR \
	&& cp -r $SOURCE_DIR/* $BUILD_DIR/ \
	&& cd $BUILD_DIR \
	&& source oe-core/oe-init-build-env build bitbake \
	&& DL_DIR=$SHARED_DOWNLOADS SSTATE_DIR=$SHARED_SSTATE MACHINE=$TARGET_MACHINE $BUILD_DIR/bitbake/bin/bitbake core-image-minimal"
cp --dereference $BUILD_DIR/build/tmp-glibc/deploy/images/$TARGET_MACHINE/core-image-minimal-$TARGET_MACHINE.tar.gz  $DEST_DIR/rootfs.tar.gz
