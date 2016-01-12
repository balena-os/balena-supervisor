package device

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"sync"
	"time"

	"resin-supervisor/gosuper/config"
	"resin-supervisor/gosuper/supermodels"
	"resin-supervisor/gosuper/utils"
)

var Uuid string

const uuidByteLength = 31
const preloadedAppsPath = "/boot/apps.json"

type Device struct {
	Uuid          string
	Bootstrapped  bool
	waitChannels  []chan bool
	bootstrapLock sync.Mutex
}

func readConfigAndEnsureUuid(superConfig config.SupervisorConfig) (uuid string, err error) {
	var userConfig config.UserConfig
	if userConfig, err = config.ReadConfig(config.DefaultConfigPath); err != nil {
	} else if userConfig.Uuid != "" {
		uuid = userConfig.Uuid
	} else if uuid, err = utils.RandomHexString(uuidByteLength); err != nil {
		userConfig.Uuid = uuid
		err = config.WriteConfig(userConfig, config.DefaultConfigPath)
	}
	if err != nil {
		time.Sleep(time.Duration(superConfig.BootstrapRetryDelay) * time.Millisecond)
		return readConfigAndEnsureUuid(superConfig)
	}
	return
}

// This should be moved to application or supermodels?
func loadPreloadedApps(appsCollection *supermodels.AppsCollection) {
	var err error
	var apps []supermodels.App
	if data, err := ioutil.ReadFile(preloadedAppsPath); err == nil {
		if err = json.Unmarshal(data, &apps); err == nil {
			for _, app := range apps {
				if err = appsCollection.CreateOrUpdate(&app); err != nil {
					break
				}
			}
		}
	}
	if err != nil {
		log.Printf("Could not load preloaded apps: %s", err)
	}
}

// TODO
func (dev *Device) bootstrap() (err error) {
	if err = dev.register()
}

func (dev *Device) BootstrapOrRetry() {
	if err = dev.bootstrap(); err != nil {
		log.Printf("Device bootstrap failed, retrying: %s", err)
		time.AfterFunc(time.Duration(superConfig.BootstrapRetryDelay)*time.Millisecond, dev.BootstrapOrRetry())
	}
}

func New(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config, superConfig config.SupervisorConfig) (dev *Device, err error) {
	device := Device{}
	var uuid string
	if uuid, err = dbConfig.Get("uuid"); err != nil {
	} else if uuid != "" {
		device.Uuid = uuid
		device.FinishBootstrapping()
	} else {
		log.Printf("New device detected, bootstrapping...")
		if uuid, err = readConfigAndEnsureUuid(superConfig); err == nil {
			device.Uuid = uuid
			loadPreloadedApps(appsCollection)
			device.BootstrapOrRetry()
			dev = &device
		}
	}
	return
}

// TODO
func (dev Device) GetId() {

}

func (dev Device) WaitForBootstrap() {
	dev.bootstrapLock.Lock()
	if dev.Bootstrapped {
		dev.bootstrapLock.Unlock()
	} else {
		_ = append(dev.waitChannels, make(chan bool))
		dev.bootstrapLock.Unlock()
		<-dev.waitChannels[len(dev.waitChannels)]
	}
}

func (dev Device) FinishBootstrapping() {
	dev.bootstrapLock.Lock()
	dev.Bootstrapped = true
	for _, c := range dev.waitChannels {
		c <- true
	}
	dev.bootstrapLock.Unlock()
}
