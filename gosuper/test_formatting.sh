#!/bin/bash

if [[ -n "$(gofmt -l .)" ]]; then
	echo "Bad formatting, run make format-gosuper to fix it."
	exit 1
else
	echo "Formatting test passed."
fi
