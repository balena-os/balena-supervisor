#!/bin/bash

go install -a -v ./...
RETURN_VALUE=$?

# For consistency, always keep the binary within a linux_$GOARCH folder
if [ $GOARCH == "amd64" ]; then
	mkdir $GOPATH/bin/linux_$GOARCH || true
	cp $GOPATH/bin/gosuper $GOPATH/bin/linux_$GOARCH/
fi
chown -R $USER_ID:$GROUP_ID $GOPATH/bin

exit $RETURN_VALUE
