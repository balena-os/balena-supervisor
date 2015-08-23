#!/bin/bash

set -o errexit
set -o pipefail

DOCKER_ROOT=${DOCKER_ROOT:-/var/lib/docker}
BTRFS_ROOT=${BTRFS_ROOT:-$DOCKER_ROOT/btrfs/subvolumes}

src=$1
dest=$2
config=$3

src_id=$(docker inspect -f '{{ .Id }}' "$src")
dest_id=$(cat /app/empty.tar | docker import -)

jq ".config=$config" "$DOCKER_ROOT/graph/$dest_id/json" > "$DOCKER_ROOT/graph/$dest_id/json.tmp"
mv "$DOCKER_ROOT/graph/$dest_id/json.tmp" "$DOCKER_ROOT/graph/$dest_id/json"

btrfs subvolume delete "$BTRFS_ROOT/$dest_id"
btrfs subvolume snapshot "$BTRFS_ROOT/$src_id" "$BTRFS_ROOT/$dest_id"

rsync --timeout=300 --archive --delete --read-batch=- "$BTRFS_ROOT/$dest_id"

docker tag -f "$dest_id" "$dest"
