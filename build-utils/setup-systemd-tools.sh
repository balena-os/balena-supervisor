#!/bin/sh

set -e

# journalctl
mkdir -p /sysroot/bin
cp /bin/journalctl /sysroot/bin/
# Get all library dependencies from the binary
for lib in $(ldd /bin/journalctl | grep -oE '(\/.+?) '); do
	mkdir -p "/sysroot/$(dirname "$lib")"
	# Copy the dependency dereferencing any symlinks
	cp -L "$lib" "/sysroot/$lib"
done

# systemd-run
mkdir -p /sysroot/usr/bin
cp /usr/bin/systemd-run /sysroot/usr/bin/
# Get all library dependencies from the binary
for lib in $(ldd /usr/bin/systemd-run | grep -oE '(\/.+?) '); do
	mkdir -p "/sysroot/$(dirname "$lib")"
	# Copy the dependency dereferencing any symlinks
	cp -L "$lib" "/sysroot/$lib"
done
