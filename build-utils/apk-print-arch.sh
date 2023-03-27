#!/bin/sh
# detect-arch.sh

apk_arch=$(apk --print-arch)
case $apk_arch in
x86_64)
	printf "amd64"
	;;
aarch64)
	printf "aarch64"
	;;
armv7)
	printf "armv7hf"
	;;
armhf)
	printf "rpi"
	;;
x86)
	printf "i386"
	;;
*)
	printf "%s" "$apk_arch"
	;;
esac
