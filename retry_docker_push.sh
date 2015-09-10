#!/bin/bash

IMAGE=$1
retries=0

while [ "$retries" -lt 3 ]; do
	let retries=retries+1
	docker push $IMAGE
	ret=$?
	if [ "$ret" -eq 0 ]; then
		break
	fi
done

exit $ret
