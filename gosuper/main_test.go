package main
import (
	"testing"
)

func TestAdd(t *testing.T) {
	v := add(1,1)
	if v != 2 {
		t.Error("1+1 != 2")
	}
}