#!/bin/bash
set -e

# Jenkins build steps
export ESCAPED_BRANCH_NAME=$(echo $sourceBranch | sed 's/[^a-z0-9A-Z_.-]/-/g')
BASE_IMAGE_VERSION=$(tar -c --mtime='1970-01-01' --owner=0 --group=0 -f - base-image | md5sum | awk -F " " '{print $1}')
export BASE_IMAGE_REPO=resin/$ARCH-supervisor-base
export BASE_IMAGE_TAG=resin/$ARCH-supervisor-base:$BASE_IMAGE_VERSION

# Try to pull the base image according to the contents of the base-image folder, otherwise build it
docker pull $BASE_IMAGE_TAG || (cd base-image && bash -ex automation/jenkins-build.sh)

# Try pulling the old build first for caching purposes.
docker pull resin/${ARCH}-supervisor:${ESCAPED_BRANCH_NAME} || docker pull resin/${ARCH}-supervisor:master || true
# Also pull the intermediate images, if possible, to improve caching
NODE_SUPERVISOR_REPO=registry.resinstaging.io/resin/node-supervisor-${ARCH}
GO_SUPERVISOR_REPO=registry.resinstaging.io/resin/go-supervisor-${ARCH}
docker pull ${NODE_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} || docker pull ${NODE_SUPERVISOR_REPO}:master || true
docker pull ${GO_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} || docker pull ${GO_SUPERVISOR_REPO}:master || true

# Test the gosuper
make SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME} JOB_NAME=${JOB_NAME} test-gosuper

MAKE_ARGS="ARCH=${ARCH} \
    ESCAPED_BASE_IMAGE_TAG=$(echo $BASE_IMAGE_TAG | sed -e 's/\//\\\//g; s/\./\\\./g') \
    PUBNUB_SUBSCRIBE_KEY=${PUBNUB_SUBSCRIBE_KEY} \
    PUBNUB_PUBLISH_KEY=${PUBNUB_PUBLISH_KEY} \
    MIXPANEL_TOKEN=${MIXPANEL_TOKEN} \
    SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME}"

make ${MAKE_ARGS} \
    DEPLOY_REGISTRY= \
    deploy

# Try to push the intermediate images to improve caching in future builds
docker tag resin/node-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} ${NODE_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} \
	|| docker tag -f resin/node-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} ${NODE_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} \
	|| true
docker tag -f resin/go-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} ${GO_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} \
	|| docker tag -f resin/go-supervisor-${ARCH}:${ESCAPED_BRANCH_NAME} ${GO_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} \
	|| true
docker push ${NODE_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} || true
docker push ${GO_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME} || true

make ${MAKE_ARGS} \
    DEPLOY_REGISTRY=registry.resinstaging.io/ \
    deploy

# Cleanup removing by Id to actually remove the images rather than untagging them
docker rmi -f $(docker inspect -f "{{.Id}}" registry.resinstaging.io/resin/${ARCH}-supervisor:${ESCAPED_BRANCH_NAME}) || true
docker rmi -f $(docker inspect -f "{{.Id}}" resin/${ARCH}-supervisor:${ESCAPED_BRANCH_NAME}) || true
docker rmi -f $(docker inspect -f "{{.Id}}" ${NODE_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME}) || true
docker rmi -f $(docker inspect -f "{{.Id}}" ${GO_SUPERVISOR_REPO}:${ESCAPED_BRANCH_NAME}) || true
docker rmi -f $(docker inspect -f "{{.Id}}" ${BASE_IMAGE_TAG}) || true
