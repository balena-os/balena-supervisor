#!/bin/bash

DIRS=`ls -l . | egrep '^d' | awk '{print $9}'`

DIRS=`echo $DIRS | sed "s/Godeps//g"`

# and finally loop over the cleaned up directory list.
for DIR in $DIRS
do
	if [[ -n "$(gofmt -l ${DIR})" ]]; then
		echo "Bad formatting, run make format-gosuper to fix it."
		exit 1
	fi
done
echo "Formatting test passed."
