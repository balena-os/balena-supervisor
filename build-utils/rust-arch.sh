#!/bin/sh
# rust-arch.sh
# return the rust triple corresponding to the apk arch

apk_arch=$(apk --print-arch)
case $apk_arch in
x86_64)
	printf "x86_64-unknown-linux-musl"
	;;
aarch64)
	printf "aarch64-unknown-linux-musl"
	;;
armv7)
	printf "armv7-unknown-linux-musleabihf"
	;;
armhf)
	printf "arm-unknown-linux-musleabihf"
	;;
x86)
	printf "i686-unknown-linux-musl"
	;;
*)
	printf "%s" "$apk_arch"
	;;
esac
