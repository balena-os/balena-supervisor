#!/bin/bash
#
# balena-supervisor automated build
#
# Required variables:
# * ARCH
# * TAG
#
# Optional variables:
# * PUSH_IMAGES
# * CLEANUP
# * ENABLE_TESTS
# * MIXPANEL_TOKEN: default key to inject in the supervisor image
# * EXTRA_TAG: when PUSH_IMAGES is true, additional tag to push to the registries
#
# Builds the supervisor for the architecture defined by $ARCH.
# Will produce and push an image tagged as balena/$ARCH-supervisor:$TAG
#
# It pulls intermediate images for caching, if available:
# balena/$ARCH-supervisor-node:$TAG
#
# In all of these cases it will use "master" if $TAG is not found.
#
# If PUSH_IMAGES is "true", it will also push the supervisor and intermediate images (must be logged in to dockerhub)
# to the docker registry.
# If CLEANUP is "true", all images will be removed after pushing - including any relevant images
# that may have been on the host from before the build, so be careful!
# If ENABLE_TESTS is "true", tests will be run.
#
# Requires docker >= 17.05, and make.
#

set -e

THIS_FILE=$0
if [ -z "$ARCH" ] || [ -z "$TAG" ]; then
	cat $THIS_FILE | awk '{if(/^#/)print;else exit}' | tail -n +2 | sed 's/\#//'
	exit 1
fi

# This is the supervisor image we will produce
TARGET_IMAGE=balena/$ARCH-supervisor:$TAG$DEBUG

# Intermediate images and cache
NODE_IMAGE=balena/$ARCH-supervisor-node:$TAG$DEBUG
NODE_BUILD_IMAGE=balena/$ARCH-supervisor-node:$TAG-build$DEBUG

TARGET_CACHE_MASTER=balena/$ARCH-supervisor:master$DEBUG
NODE_CACHE_MASTER=balena/$ARCH-supervisor-node:master$DEBUG
NODE_BUILD_CACHE_MASTER=balena/$ARCH-supervisor-node:master-build$DEBUG

CACHE_FROM=""
function useCache() {
	image=$1
	# Always add the cache because we can't do it from
	# a subshell and specifying a missing image is fine
	CACHE_FROM="$CACHE_FROM --cache-from $image"
	# Pull in parallel for speed
	docker pull $image &
}

useCache $TARGET_IMAGE
useCache $TARGET_CACHE_MASTER
useCache $NODE_IMAGE
useCache $NODE_CACHE_MASTER
# Debug images don't include nodebuild or use the supervisor-base image
if [ -z "$DEBUG" ]; then
	useCache $NODE_BUILD_IMAGE
	useCache $NODE_BUILD_CACHE_MASTER

	docker pull balenalib/amd64-node:6-build &
	docker pull balena/$ARCH-supervisor-base:v1.4.7 &
fi
# Pull images we depend on in parallel to avoid needing
# to do it in serial during the build
docker pull balenalib/raspberry-pi-node:10-run &
docker pull balenalib/armv7hf-node:10-run &
docker pull balenalib/aarch64-node:10-run &
docker pull balenalib/amd64-node:10-run &
docker pull balenalib/i386-node:10-run &
docker pull balenalib/i386-nlp-node:6-jessie &
wait

export DOCKER_BUILD_OPTIONS=${CACHE_FROM}
export ARCH
export MIXPANEL_TOKEN

# Debug images don't include nodebuild
if [ -z "$DEBUG" ]; then
	make IMAGE=$NODE_BUILD_IMAGE nodebuild
	if [ "$PUSH_IMAGES" = "true" ]; then
		make IMAGE=$NODE_BUILD_IMAGE deploy &
	fi
	export DOCKER_BUILD_OPTIONS="${DOCKER_BUILD_OPTIONS} --cache-from ${NODE_BUILD_IMAGE}"
fi

make IMAGE=$NODE_IMAGE nodedeps
if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$NODE_IMAGE deploy &
fi
export DOCKER_BUILD_OPTIONS="${DOCKER_BUILD_OPTIONS} --cache-from ${NODE_IMAGE}"

# This is the step that actually builds the supervisor
make IMAGE=$TARGET_IMAGE supervisor

if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$TARGET_IMAGE deploy

	if [ -n "$EXTRA_TAG" ]; then
		docker tag $TARGET_IMAGE balena/$ARCH-supervisor:$EXTRA_TAG
		make IMAGE=balena/$ARCH-supervisor:$EXTRA_TAG deploy
	fi
fi

# Wait for any ongoing deploys
wait
if [ "$CLEANUP" = "true" ]; then
	docker rmi \
		$TARGET_IMAGE \
		$NODE_IMAGE \
		$NODE_BUILD_IMAGE \
		$TARGET_CACHE
fi
