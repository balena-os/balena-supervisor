package systemd

import (
	"log"
	"os/exec"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/godbus/dbus"
)

var Systemd dbus.BusObject

func init() {
	if conn, err := dbus.Dial("unix:path=/mnt/root/run/dbus/system_bus_socket"); err != nil {
		log.Fatal("Failed to connect to host system bus")
	} else {
		Systemd = conn.Object("org.freedesktop.systemd1", "/org/freedesktop/systemd1")
	}
}

func Reboot() {
	if err := exec.Command("sync").Run(); err != nil {
		log.Println(err)
	} else if call := Systemd.Call("org.freedesktop.systemd1.Reboot", 0); call.Err != nil {
		log.Println(call.Err)
	}
}

func Shutdown() {
	if err := exec.Command("sync").Run(); err != nil {
		log.Println(err)
	} else if call := Systemd.Call("org.freedesktop.systemd1.PowerOff", 0); call.Err != nil {
		log.Println(call.Err)
	}
}
