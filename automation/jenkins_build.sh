#!/bin/bash
set -e

# Jenkins build steps
VERSION=$(git describe --always --abbrev=6)
ESCAPED_BRANCH_NAME=$(echo $sourceBranch | sed 's/[^a-z0-9A-Z_.-]/-/g')

# Try pulling the old build first for caching purposes.
docker pull resin/${ARCH}-supervisor:${ESCAPED_BRANCH_NAME} || docker pull resin/${ARCH}-supervisor:master || true

# Test the gosuper
make SUPERVISOR_VERSION=${VERSION} JOB_NAME=${JOB_NAME} test-gosuper

MAKE_ARGS="ARCH=${ARCH} \
    PUBNUB_SUBSCRIBE_KEY=${PUBNUB_SUBSCRIBE_KEY} \
    PUBNUB_PUBLISH_KEY=${PUBNUB_PUBLISH_KEY} \
    MIXPANEL_TOKEN=${MIXPANEL_TOKEN}"

# Disabled until this is merged in npm https://github.com/npm/npm/pull/13257
# make ${MAKE_ARGS} lint

make ${MAKE_ARGS} \
    SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME} \
    DEPLOY_REGISTRY= \
    deploy

make ${MAKE_ARGS} \
    SUPERVISOR_VERSION=${VERSION} \
    DEPLOY_REGISTRY= \
    deploy

make ${MAKE_ARGS} \
    SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME} \
    DEPLOY_REGISTRY=registry.resinstaging.io/ \
    deploy

make ${MAKE_ARGS} \
    SUPERVISOR_VERSION=${VERSION} \
    DEPLOY_REGISTRY=registry.resinstaging.io/ \
    deploy
