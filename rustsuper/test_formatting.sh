#!/bin/bash

for file in $(find src tests -type f -name "*.rs"); do
	result=$(rustfmt --write-mode=diff $file)
	if [ -n "$result" ]; then
		echo "$result"
		failed=1
	fi
done

if [ -n "$failed" ]; then
	echo "Bad formatting, run make format-rustsuper to fix above errors."
	exit 1
fi
