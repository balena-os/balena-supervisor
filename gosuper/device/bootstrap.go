package device

import (
	"resin-supervisor/gosuper/supermodels"
)

var Uuid string

type Device struct {
	Uuid         string
	Bootstrapped bool
}

func New(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config) (dev *Device, err error) {
	device := Device{}
	dev = &device
	return
}

func (dev Device) GetId() {

}
