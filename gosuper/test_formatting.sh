#!/bin/bash

GOFMT_OUTPUT=$(gofmt -l ./[!Godeps]*/*.go)
if [[ -n "$GOFMT_OUTPUT" ]]; then
	echo $GOFMT_OUTPUT
	echo "Bad formatting, run make format-gosuper to fix it."
	exit 1
else
	echo "Formatting test passed."
fi
