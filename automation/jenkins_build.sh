#!/bin/bash
set -e

# Jenkins build steps
ESCAPED_BRANCH_NAME=$(echo $sourceBranch | sed 's/[^a-z0-9A-Z_.-]/-/g')

# Try pulling the old build first for caching purposes.
docker pull resin/${ARCH}-supervisor:${ESCAPED_BRANCH_NAME} || docker pull resin/${ARCH}-supervisor:master || true
# Also pull the intermediate images, if possible, to improve caching
docker pull registry.resinstaging.io/resin/node-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} || docker pull registry.resinstaging.io/resin/node-supervisor-${ARCH}:master || true
docker pull registry.resinstaging.io/resin/go-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} || docker pull registry.resinstaging.io/resin/go-supervisor-${ARCH}:master || true

# Test the gosuper
make SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME} JOB_NAME=${JOB_NAME} test-gosuper

MAKE_ARGS="ARCH=${ARCH} \
    PUBNUB_SUBSCRIBE_KEY=${PUBNUB_SUBSCRIBE_KEY} \
    PUBNUB_PUBLISH_KEY=${PUBNUB_PUBLISH_KEY} \
    MIXPANEL_TOKEN=${MIXPANEL_TOKEN} \
    SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME}"

make ${MAKE_ARGS} \
    DEPLOY_REGISTRY= \
    deploy

# Try to push the intermediate images to improve caching in future builds
docker tag -f resin/node-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} registry.resinstaging.io/resin/node-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} || true
docker tag -f resin/go-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} registry.resinstaging.io/resin/go-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} || true
docker push registry.resinstaging.io/resin/node-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} || true
docker push registry.resinstaging.io/resin/go-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} || true

make ${MAKE_ARGS} \
    DEPLOY_REGISTRY=registry.resinstaging.io/ \
    deploy

