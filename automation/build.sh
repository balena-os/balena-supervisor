#!/bin/bash
#
# balena-supervisor automated build
#
# Required variables:
# * ARCH
#
# Optional variables:
# * TAG: The default will be the current branch name
# * PUSH_IMAGES
# * CLEANUP
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
#
# Requires docker >= 17.05
#

set -e

THIS_FILE=$0
if [ -z "$ARCH" ] ; then
	awk '{if(/^#/)print;else exit}' "${THIS_FILE}" | tail -n +2 | sed 's/\#//'
	exit 1
fi

if [ -z "$TAG" ]; then
	TAG=$(git rev-parse --abbrev-ref HEAD)
fi

if ! [ -x "$(command -v npx)" ]; then
  echo 'NPM/npx is required to execute this script' >&2
  exit 1
fi

# This is the supervisor image we will produce
TARGET_IMAGE=balena/$ARCH-supervisor:$TAG
TARGET_BUILD_IMAGE=balena/$ARCH-supervisor:$TAG-build

MASTER_IMAGE=balena/$ARCH-supervisor:master
MASTER_BUILD_IMAGE=balena/$ARCH-supervisor:master-build

CACHE_FROM=""
function useCache() {
	image=$1
	# Always add the cache because we can't do it from
	# a subshell and specifying a missing image is fine
	CACHE_FROM="${CACHE_FROM} --cache-from $image"
	# Pull in parallel for speed
	docker pull "$image" &
}

function retryImagePush() {
	local image=$1
	local -i retries
	local success=1

	while (( retries < 3 )); do
		retries+=1
		if docker push "${image}"; then
			success=0
			break
		fi
	done

	return $success
}

# If we're building for an ARM architecture, we uncomment
# the cross-build commands, to enable emulation
function processDockerfile() {
	if [ "${ARCH}" == "aarch64" ] || [ "${ARCH}" == "armv7hf" ] || [ "${ARCH}" == "rpi" ]; then
		sed -E 's/#(.*"cross-build-(start|end)".*)/\1/g' Dockerfile
	else
		cat Dockerfile
	fi
}

export ARCH

useCache "${TARGET_IMAGE}"
useCache "${TARGET_BUILD_IMAGE}"
useCache "${MASTER_IMAGE}"
useCache "${MASTER_BUILD_IMAGE}"

# Wait for our cache to be downloaded
wait

BUILD_ARGS="$CACHE_FROM --build-arg ARCH=${ARCH}"
# Try to build the first stage
processDockerfile | docker build -f - -t "${TARGET_BUILD_IMAGE}" --target BUILD ${BUILD_ARGS} .

# Now try to build the final stage
processDockerfile | docker build -f - -t "${TARGET_IMAGE}" ${BUILD_ARGS} .

if [ "${PUSH_IMAGES}" == "true" ]; then
	retryImagePush "${TARGET_BUILD_IMAGE}" &
	retryImagePush "${TARGET_IMAGE}" &

	if [ -n "${EXTRA_TAG}" ]; then
		docker tag "${TARGET_IMAGE}" "balena/${ARCH}-supervisor:${EXTRA_TAG}"
		retryImagePush "balena/${ARCH}-supervisor:${EXTRA_TAG}" &
	fi
fi

# Wait for any ongoing deploys
wait

if [ "$CLEANUP" = "true" ]; then
	docker rmi \
		"${TARGET_IMAGE}" \
		"${TARGET_BUILD_IMAGE}" \
		"${MASTER_IMAGE}" \
		"${MASTER_BUILD_IMAGE}"
fi


