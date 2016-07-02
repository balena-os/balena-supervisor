#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'

mkdir -p $BUILD_DIR
cp -r $SOURCE_DIR/* $BUILD_DIR/
cd $BUILD_DIR
source poky/oe-init-build-env build
bitbake core-image-minimal
qemu=$(cat conf/local.conf | grep '^MACHINE ??= ' | grep -o '"[^"]\+"' | tr -d '"')
cp --dereference tmp/deploy/images/$qemu/core-image-minimal-$qemu.tar.gz  $DEST_DIR/rootfs.tar.gz
