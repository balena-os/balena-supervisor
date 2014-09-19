#!/bin/sh

set -e

[ -d /dev/net ] ||
    mkdir -p /dev/net
[ -c /dev/net/tun ] ||
    mknod /dev/net/tun c 10 200

cd /app

set DATA_DIRECTORY = /data
if [ -d "$DATA_DIRECTORY" ]; then
	cp bin/enter.sh $DATA_DIRECTORY/enter.sh
	chmod +x $DATA_DIRECTORY/enter.sh
fi

exec node src/supervisor.js
