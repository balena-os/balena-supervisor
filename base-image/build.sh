#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'

mkdir -p $BUILD_DIR
cp -r $SOURCE_DIR/* $BUILD_DIR/
cd $BUILD_DIR
source poky/oe-init-build-env build
bitbake core-image-minimal
cd tmp/deploy/images/
cp $(find . -name *.rootfs.tar.gz) $DEST_DIR/rootfs.tar.gz
