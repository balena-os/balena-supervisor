package main

import (
	"strconv"
)

func IsValidAppId(appId string) (valid bool) {
	_, err := strconv.ParseUint(appId, 10, 0)
	valid = err == nil
	return
}
