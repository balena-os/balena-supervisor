#!/bin/bash

go install -a -v ./gosuper
RETURN_VALUE=$?

HOSTARCH=$(uname -m)
# For consistency, always keep the binary within a linux_$GOARCH folder
if [[ ( $GOARCH == "amd64" && $HOSTARCH == "x86_64" ) || ( $GOARCH == "arm" && $HOSTARCH == "armv7l" ) ]]; then
	mkdir -p $GOPATH/bin/linux_$GOARCH
	cp $GOPATH/bin/gosuper $GOPATH/bin/linux_$GOARCH/
fi
chown -R $USER_ID:$GROUP_ID $GOPATH/bin

exit $RETURN_VALUE
