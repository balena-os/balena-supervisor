#!/bin/sh

set -ex

DEBIAN=libdbus-1-dev
OSX=dbus

if command -v apt > /dev/null; then
    if dpkg --list | grep $DEBIAN > /dev/null; then
        exit 0
    else
        echo "Installing $DEBIAN..."
        sudo apt-get update
        sudo apt-get install $DEBIAN
    fi
elif command -v brew > /dev/null; then
    brew list $OSX > /dev/null || (echo "Installing $OSX..." && brew install $OSX)
else
    echo "Neither 'brew' nor 'apt' are available to this system.
Please make sure Supervisor development is done on Linux, OSX, or WSL2,
and that one of the above package managers is installed. If using a
Linux distro without 'apt', please install the dbus development lib
available to your system and run 'npm ci --ignore-scripts' to continue."
    exit 0
fi
