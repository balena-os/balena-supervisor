package systemd

import (
	"log"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/coreos/go-systemd/login1"
)

var Logind *login1.Conn

func init() {
	var err error
	if Logind, err = login1.New(); err != nil {
		log.Fatal("Failed to connect to host system bus")
	}
}
