#!/bin/bash

set -o errexit

BUILD_DIR='/home/builder/tmp'

mkdir -p $BUILD_DIR
cp -r $SOURCE_DIR/* $BUILD_DIR/
cd $BUILD_DIR
source poky/oe-init-build-env build
bitbake -k core-image-minimal
cd tmp/deploy/images/
cp $(find . -name *.rootfs.tar.bz2) $DEST_DIR/rootfs.tar.bz2
