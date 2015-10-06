package systemd

import (
	"log"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/coreos/go-systemd/dbus"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/coreos/go-systemd/login1"
)

var (
	// Logind Systemd Login1 connection
	Logind *login1.Conn
	// Dbus Systems Dbus connection
	Dbus *dbus.Conn
)

func init() {
	var err error
	if Logind, err = login1.New(); err != nil {
		log.Fatal("Failed to connect to host system bus")
	}
	if Dbus, err = dbus.New(); err != nil {
		log.Fatal("Failed to connect to host DBUS ")
	}
}
