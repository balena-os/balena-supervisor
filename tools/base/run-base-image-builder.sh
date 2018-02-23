#!/bin/bash
#
# Runs bash in a container using the resin/$ARCH-supervisor-base image
# ($ARCH defaults to amd64)
#
# The base-image folder will be bind mounted at /source.
# You can then build the base image with `bash -ex build.sh`
#

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [ -z "$ARCH" ]; then
	ARCH=amd64
fi

docker run -ti -e ARCH=$ARCH -v $DIR/../../base-image:/source resin/$ARCH-supervisor-base bash
