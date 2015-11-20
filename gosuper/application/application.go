package application

import (
	"fmt"
	"log"
	"os"
	"time"

	"resin-supervisor/gosuper/config"
	"resin-supervisor/gosuper/device"
	"resin-supervisor/gosuper/supermodels"
)

type App supermodels.App

type Manager struct {
	Device       *device.Device
	Apps         *supermodels.AppsCollection
	Config       *supermodels.Config
	PollInterval int64
}

func NewManager(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config, dev *device.Device, superConfig config.SupervisorConfig) (*Manager, error) {
	manager := Manager{Apps: appsCollection, Config: dbConfig, Device: dev, PollInterval: 30000}
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

func (app *App) Kill() (err error) {
	log.Printf("Killing app %d", app.AppId)
	return
}

func (app *App) Start() (err error) {
	log.Printf("Starting app %d", app.AppId)
	return
}

type AppCallback supermodels.AppCallback

func (manager Manager) lockPath(app *supermodels.App) string {
	return fmt.Sprintf("/mnt/root/resin-data/%d/resin-updates.lock", app.AppId)
}

func (manager Manager) LockAndDo(app *App, callback AppCallback) error {
	return manager.Apps.GetAndDo((*supermodels.App)(app), func(a *supermodels.App) error {
		// Here 'a' is the app from the DB, which is current and has a r/w lock
		path := manager.lockPath(a)
		if lock, er := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0777); er != nil {
			return er
		} else {
			er = callback(a)
			if e := lock.Close(); e != nil {
				log.Printf("Error closing lockfile: %s\n", e)
			}
			if e := os.Remove(path); e != nil {
				log.Printf("Error releasing lockfile: %s\n", e)
			}
			return er
		}
	})
}
