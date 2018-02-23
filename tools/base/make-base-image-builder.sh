#!/bin/bash
#
# Produces a resin/$ARCH-supervisor-base-builder image
# ($ARCH defaults to amd64)
#

if [ -z "$ARCH" ]; then
	ARCH=amd64
fi

make ARCH=$ARCH \
	IMAGE=resin/$ARCH-supervisor-base \
	DOCKER_BUILD_OPTIONS="--build-arg SKIP_BASE_IMAGE_BUILD=true" \
	base
