#!/bin/bash
#
# resin-supervisor automated build
#
# Required variables:
# * ARCH
# * TAG
#
# Optional variables:
# * PUSH_IMAGES
# * CLEANUP
# * ENABLE_TESTS
# * PUBNUB_SUBSCRIBE_KEY, PUBNUB_PUBLISH_KEY, MIXPANEL_TOKEN: default keys to inject in the supervisor image
# * EXTRA_TAG: when PUSH_IMAGES is true, additional tag to push to the registries
#
# Builds the supervisor for the architecture defined by $ARCH.
# Will produce and push an image tagged as resin/$ARCH-supervisor:$TAG
#
# It pulls intermediate images for caching, if available:
# resin/$ARCH-supervisor-base:$TAG
# resin/$ARCH-supervisor-node:$TAG
# resin/$ARCH-supervisor-go:$TAG
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
# If you just cloned the repo, run this to populate the yocto dependencies before running this script:
# git submodule update --init --recursive
# git clean -fxd base-image
# git submodule foreach --recursive git clean -fxd
#

set -e

THIS_FILE=$0
if [ -z "$ARCH" ] || [ -z "$TAG" ]; then
	cat $THIS_FILE | awk '{if(/^#/)print;else exit}' | tail -n +2 | sed 's/\#//'
	exit 1
fi

function tryRemove() {
	docker rmi $1 || true
}

# This is the supervisor image we will produce
TARGET_IMAGE=resin/$ARCH-supervisor:$TAG

# Intermediate images and cache
BASE_IMAGE=resin/$ARCH-supervisor-base:$TAG
NODE_IMAGE=resin/$ARCH-supervisor-node:$TAG
NODE_BUILD_IMAGE=resin/$ARCH-supervisor-node:$TAG-build
GO_IMAGE=resin/$ARCH-supervisor-go:$TAG

TARGET_CACHE=$TARGET_IMAGE
BASE_CACHE=$BASE_IMAGE
GO_CACHE=$GO_IMAGE
NODE_CACHE=$NODE_IMAGE
NODE_BUILD_CACHE=$NODE_BUILD_IMAGE

TARGET_CACHE_MASTER=resin/$ARCH-supervisor:master
BASE_CACHE_MASTER=resin/$ARCH-supervisor-base:master
GO_CACHE_MASTER=resin/$ARCH-supervisor-go:master
NODE_CACHE_MASTER=resin/$ARCH-supervisor-node:master
NODE_BUILD_CACHE_MASTER=resin/$ARCH-supervisor-node:master-build

CACHE_FROM=""
function tryPullForCache() {
	image=$1
	docker pull $image && {
		CACHE_FROM="$CACHE_FROM --cache-from $image"
	} || true
}

# Attempt to pull images for cache
# Only if the pull succeeds we add a --cache-from option
tryPullForCache $TARGET_CACHE
tryPullForCache $TARGET_CACHE_MASTER
tryPullForCache $BASE_CACHE
tryPullForCache $BASE_CACHE_MASTER
tryPullForCache $GO_CACHE
tryPullForCache $GO_CACHE_MASTER
tryPullForCache $NODE_CACHE
tryPullForCache $NODE_CACHE_MASTER
tryPullForCache $NODE_BUILD_CACHE
tryPullForCache $NODE_BUILD_CACHE_MASTER

if [ "$ENABLE_TESTS" = "true" ]; then
	make ARCH=$ARCH IMAGE=$GO_IMAGE test-gosuper
fi

export DOCKER_BUILD_OPTIONS=${CACHE_FROM}
export ARCH
export PUBNUB_PUBLISH_KEY
export PUBNUB_SUBSCRIBE_KEY
export MIXPANEL_TOKEN

make IMAGE=$BASE_IMAGE base
if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$BASE_IMAGE deploy || true
fi
export DOCKER_BUILD_OPTIONS="${DOCKER_BUILD_OPTIONS} --cache-from ${BASE_IMAGE}"

make IMAGE=$GO_IMAGE gosuper
if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$GO_IMAGE deploy || true
fi
export DOCKER_BUILD_OPTIONS="${DOCKER_BUILD_OPTIONS} --cache-from ${GO_IMAGE}"

make IMAGE=$NODE_BUILD_IMAGE nodebuild
if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$NODE_BUILD_IMAGE deploy || true
fi
export DOCKER_BUILD_OPTIONS="${DOCKER_BUILD_OPTIONS} --cache-from ${NODE_BUILD_IMAGE}"

make IMAGE=$NODE_IMAGE nodedeps
if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$NODE_IMAGE deploy || true
fi
export DOCKER_BUILD_OPTIONS="${DOCKER_BUILD_OPTIONS} --cache-from ${NODE_IMAGE}"

# This is the step that actually builds the supervisor
make IMAGE=$TARGET_IMAGE supervisor

if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$TARGET_IMAGE deploy

	if [ -n "$EXTRA_TAG" ]; then
		docker tag $TARGET_IMAGE resin/$ARCH-supervisor:$EXTRA_TAG
		make IMAGE=resin/$ARCH-supervisor:$EXTRA_TAG deploy
	fi
fi

if [ "$CLEANUP" = "true" ]; then
	tryRemove $TARGET_IMAGE

	tryRemove $BASE_IMAGE
	tryRemove $GO_IMAGE
	tryRemove $NODE_IMAGE
	tryRemove $NODE_BUILD_IMAGE

	tryRemove $TARGET_CACHE
	tryRemove $BASE_CACHE
	tryRemove $GO_CACHE
	tryRemove $NODE_BUILD_CACHE
	tryRemove $NODE_CACHE
fi
