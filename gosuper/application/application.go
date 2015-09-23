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
type Manager struct {
	Device       *device.Device
	PollInterval int64
}

func NewManager(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config, dev *device.Device) (*Manager, error) {
	manager := Manager{Device: dev, PollInterval: 30000}
	manager.StartUpdateInterval()
	return &manager, nil
}

func (manager Manager) StartUpdateInterval() {
	go manager.UpdateInterval()
}

func (manager Manager) UpdateInterval() {
	for {
		if manager.Device.Bootstrapped {
			manager.Update(false)
		}
		time.Sleep(time.Duration(manager.PollInterval) * time.Millisecond)
	}
}

func (manager Manager) Update(force bool) {

}
