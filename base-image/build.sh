#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'

mkdir -p $BUILD_DIR
cp -r $SOURCE_DIR/* $BUILD_DIR/
cd $BUILD_DIR
source oe-core/oe-init-build-env build bitbake
MACHINE=$TARGET_MACHINE bitbake core-image-minimal
cp --dereference tmp-glibc/deploy/images/$TARGET_MACHINE/core-image-minimal-$TARGET_MACHINE.tar.gz  $DEST_DIR/rootfs.tar.gz
