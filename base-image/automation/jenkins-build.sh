#!/bin/bash

set -o errexit
set -o pipefail

date=$(date +'%Y%m%d' -u)
REPO='resin/amd64-supervisor-base'

git submodule update --init --recursive
rm -rf dest
mkdir dest

docker build -t supervisor-base-builder .
docker run --rm \
	-v `pwd`:/source \
	-v `pwd`/dest:/dest \
	supervisor-base-builder
if [ -f dest/rootfs.tar.gz ]; then
	cat dest/rootfs.tar.gz | docker import - $REPO:$date
	docker tag -f $REPO:$date $REPO:latest
	docker push $REPO
else
	echo "rootfs is missing!"
	exit 1
fi
