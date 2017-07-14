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
# If PUSH_IMAGES is "true", it will also push the supervisor and intermediate images
# to the docker registry. The supervisor image will also be pushed to registry.resinstaging.io
# so that devices with older docker versions can pull it from there (it's a v1 registry).
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
GO_IMAGE=resin/$ARCH-supervisor-go:$TAG

TARGET_CACHE=$TARGET_IMAGE
BASE_CACHE=$BASE_IMAGE
GO_CACHE=$GO_IMAGE
NODE_CACHE=$NODE_IMAGE

CACHE_FROM=""
# Attempt to pull images for cache
# Only if the pull succeeds we add a --cache-from option
docker pull $TARGET_CACHE || {
	TARGET_CACHE=resin/$ARCH-supervisor:master
	docker pull $TARGET_CACHE
} && {
	CACHE_FROM="$CACHE_FROM --cache-from $TARGET_CACHE"
} || true

docker pull $BASE_CACHE || {
	BASE_CACHE=resin/$ARCH-supervisor-base:master
	docker pull $BASE_CACHE
} && {
	CACHE_FROM="$CACHE_FROM --cache-from $BASE_CACHE"
} || true

docker pull $NODE_CACHE || {
	NODE_CACHE=resin/$ARCH-supervisor-node:master
	docker pull $NODE_CACHE
} && {
	CACHE_FROM="$CACHE_FROM --cache-from $NODE_CACHE"
} || true

docker pull $GO_CACHE || {
	GO_CACHE=resin/$ARCH-supervisor-go:master
	docker pull $GO_CACHE
} && {
	CACHE_FROM="$CACHE_FROM --cache-from $GO_CACHE"
} || true

if [ "$ENABLE_TESTS" = "true" ]; then
	make ARCH=$ARCH IMAGE=$GO_IMAGE test-gosuper
fi

export DOCKER_BUILD_OPTIONS=${CACHE_FROM}
export ARCH
export PUBNUB_PUBLISH_KEY
export PUBNUB_SUBSCRIBE_KEY
export MIXPANEL_TOKEN

# This is the step that actually builds the supervisor
make IMAGE=$TARGET_IMAGE supervisor

if [ "$PUSH_IMAGES" = "true" ]; then
	make IMAGE=$TARGET_IMAGE deploy
	docker tag $TARGET_IMAGE registry.resinstaging.io/$TARGET_IMAGE
	make IMAGE=registry.resinstaging.io/$TARGET_IMAGE deploy

	if [ -n "$EXTRA_TAG" ]; then
		docker tag $TARGET_IMAGE resin/$ARCH-supervisor:$EXTRA_TAG
		make IMAGE=resin/$ARCH-supervisor:$EXTRA_TAG deploy
		docker tag $TARGET_IMAGE registry.resinstaging.io/resin/$ARCH-supervisor:$EXTRA_TAG
		make IMAGE=registry.resinstaging.io/resin/$ARCH-supervisor:$EXTRA_TAG deploy
	fi

	# Try to push the intermediate images to improve caching in future builds
	# But we don't care much if any of this fails.
	( make IMAGE=$BASE_IMAGE base && make IMAGE=$BASE_IMAGE deploy ) || true
	( make IMAGE=$GO_IMAGE gosuper && make IMAGE=$GO_IMAGE deploy ) || true
	( make IMAGE=$NODE_IMAGE node && make IMAGE=$NODE_IMAGE deploy ) || true
fi

if [ "$CLEANUP" = "true" ]; then
	tryRemove $TARGET_IMAGE

	# Only attempt to remove intermediate imaegs if we built them
	if [ "$PUSH_IMAGES" = "true" ]; then
		tryRemove $BASE_IMAGE
		tryRemove $GO_IMAGE
		tryRemove $NODE_IMAGE
	fi

	tryRemove $TARGET_CACHE
	tryRemove $BASE_CACHE
	tryRemove $GO_CACHE
	tryRemove $NODE_CACHE
fi
