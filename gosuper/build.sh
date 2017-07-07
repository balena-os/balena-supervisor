#!/bin/bash

set -o errexit

./test_formatting.sh
go test -v ./gosuper

case "$ARCH" in
'amd64')
	export GOARCH=amd64
;;
'i386')
	export GOARCH=386
;;
'rpi')
	export GOARCH=arm
	export GOARM=6
;;
'armv7hf')
	export GOARCH=arm
	export GOARM=7
;;
'armel')
	export GOARCH=arm
	export GOARM=5
;;
'aarch64')
	export GOARCH=arm64
;;
esac

go install -a -v ./gosuper \
	&& cd /go/bin \
	&& find -type f -name gosuper -exec mv {} /go/bin/gosuper \; \
	&& upx --best /go/bin/gosuper
