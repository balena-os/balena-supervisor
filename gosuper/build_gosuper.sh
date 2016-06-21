#!/bin/sh

go install -a -v ./gosuper
RETURN_VALUE=$?

HOSTARCH=$(uname -m)
# For consistency, always keep the binary within a linux_$GOARCH folder
if test "$GOARCH" = "amd64" -a "$HOSTARCH" = "x86_64" || test "$GOARCH" = "arm" -a "$HOSTARCH" = "armv7l"; then
	mkdir -p $GOPATH/bin/linux_$GOARCH
	cp $GOPATH/bin/gosuper $GOPATH/bin/linux_$GOARCH/
fi
chown -R $USER_ID:$GROUP_ID $GOPATH/bin

exit $RETURN_VALUE
