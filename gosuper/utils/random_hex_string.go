package utils

import (
	"crypto/rand"
	"fmt"
)

func RandomHexString(byteLength uint32) (str string, err error) {
	slice := make([]byte, byteLength)
	if _, err = rand.Read(slice); err == nil {
		str = fmt.Sprintf("%x", slice)
	}
	return
}
