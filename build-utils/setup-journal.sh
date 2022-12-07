#!/bin/sh

set -e

mkdir -p /sysroot/bin
cp /bin/journalctl /sysroot/bin/
# Get all library dependencies from the binary
for lib in $(ldd /bin/journalctl | grep -oE '(\/.+?) '); do
	mkdir -p "/sysroot/$(dirname "$lib")"
	# Copy the dependency dereferencing any symlinks
	cp -L "$lib" "/sysroot/$lib"
done
