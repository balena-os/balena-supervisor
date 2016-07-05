#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'

mkdir -p $BUILD_DIR
cp -r $SOURCE_DIR/* $BUILD_DIR/
cd $BUILD_DIR
source poky/oe-init-build-env build
sed -e s~#{MACHINE_NAME}~"$TARGET_MACHINE"~g conf/local.conf.tpl > conf/local.conf
bitbake core-image-minimal
cp --dereference tmp/deploy/images/$TARGET_MACHINE/core-image-minimal-$TARGET_MACHINE.tar.gz  $DEST_DIR/rootfs.tar.gz
