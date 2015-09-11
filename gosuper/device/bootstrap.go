package device

import (
	"resin-supervisor/gosuper/supermodels"
)

var Uuid string

type Device struct {
	Uuid         string
	Bootstrapped bool
}

var device Device

func Initialize(appsCollection supermodels.AppsCollection, dbConfig supermodels.Config) (dev *Device, err error) {
	dev = &device
	return
}

func (dev Device) GetId() {

}
