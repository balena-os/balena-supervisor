#!/bin/bash
set -e

# Jenkins build steps
VERSION=$(git describe --always --abbrev=6)
ESCAPED_BRANCH_NAME=$(echo $sourceBranch | sed 's/[^a-z0-9A-Z_.-]/-/g')

# Build the images
make SUPERVISOR_VERSION=${ESCAPED_BRANCH_NAME} ARCH=${ARCH} DEPLOY_REGISTRY= deploy
make SUPERVISOR_VERSION=${VERSION} ARCH=${ARCH} DEPLOY_REGISTRY= deploy
