package application

import (
	"time"

	"resin-supervisor/gosuper/device"
	"resin-supervisor/gosuper/supermodels"
)

type App struct {
	AppId       int
	Commit      string
	ImageId     string
	Env         map[string]string
	ContainerId string
}
type ApplicationManager struct {
	Device       *device.Device
	PollInterval int64
}

var manager ApplicationManager

func Initialize(appsCollection supermodels.AppsCollection, dbConfig supermodels.Config, dev *device.Device) (*ApplicationManager, error) {
	manager.Device = dev
	manager.StartUpdateInterval()
	manager.PollInterval = 30000
	return &manager, nil
}

func (manager ApplicationManager) StartUpdateInterval() {
	go manager.UpdateInterval()
}

func (manager ApplicationManager) UpdateInterval() {
	for {
		if manager.Device.Bootstrapped {
			manager.Update(false)
		}
		time.Sleep(time.Duration(manager.PollInterval) * time.Millisecond)
	}
}

func (manager ApplicationManager) Update(force bool) {

}
