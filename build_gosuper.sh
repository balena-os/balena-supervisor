#!/bin/bash

set -e
go install -a -v ./...

# For consistency, always keep the binary within a linux_$GOARCH folder
if (( $GOARCH == "amd64" )); then
	mkdir $GOPATH/bin/linux_$GOARCH || true
	cp $GOPATH/bin/gosuper $GOPATH/bin/linux_$GOARCH/
fi
chmod -R a+rwx $GOPATH/bin
	