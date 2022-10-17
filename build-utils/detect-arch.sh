#!/bin/sh
# detect-arch.sh

case $(uname -m) in
x86_64)
	echo "amd64"
	;;
aarch64)
	:
	echo "aarch64"
	;;
arm64)
	echo "aarch64"
	;;
armv7l)
	echo "armv7hf"
	;;
armv6l)
	echo "rpi"
	;;
i686)
	:
	echo "i386"
	;;
i386)
	:
	echo "i386"
	;;
*)
	echo >&2 "Unknown architecture $(uname -m)"
	exit 1
	;;
esac
