#!/bin/bash

for dir in $(find ./* -path ./Godeps -prune -or -type d -print); do
	if [[ -n "$(gofmt -l ${dir})" ]]; then
		echo "Bad formatting, run make format-gosuper to fix it."
		exit 1
	fi
done
