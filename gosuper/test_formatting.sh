#!/bin/bash

for dir in $(find ./* -path ./Godeps -prune -or -type d -print); do
	errormessage=$(gofmt -l $dir)
	if [ $errormessage ]
	then
		echo "$errormessage"
		failed=true
	fi
done

if [ $failed ]
then
	echo "Bad formatting, run make format-gosuper to fix above errors."
	exit 1
fi
