package device

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"sync"
	"time"

	"github.com/resin-io/resin-supervisor/gosuper/config"
	"github.com/resin-io/resin-supervisor/gosuper/resin"
	"github.com/resin-io/resin-supervisor/gosuper/supermodels"
	"github.com/resin-io/resin-supervisor/gosuper/utils"
)

var Uuid string

const uuidByteLength = 31
const preloadedAppsPath = "/boot/apps.json"

type Device struct {
	Uuid          string
	Bootstrapped  bool
	waitChannels  []chan bool
	bootstrapLock sync.Mutex
	Config        config.UserConfig
	DbConfig      *supermodels.Config
	SuperConfig   config.SupervisorConfig
}

func (dev Device) readConfigAndEnsureUuid(superConfig config.SupervisorConfig) (uuid string, err error) {
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
		return dev.readConfigAndEnsureUuid(superConfig)
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

func (dev *Device) bootstrap() (err error) {
	if err = dev.register(); err != nil {
		return err
	}
	return config.SaveToDB(dev.Config)
}

func (dev *Device) BootstrapOrRetry() {
	if err := dev.bootstrap(); err != nil {
		log.Printf("Device bootstrap failed, retrying: %s", err)
		time.AfterFunc(time.Duration(dev.SuperConfig.BootstrapRetryDelay)*time.Millisecond, dev.BootstrapOrRetry)
	}
}

func New(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config, superConfig config.SupervisorConfig) (dev *Device, err error) {
	device := Device{}
	var uuid string
	device.DbConfig = dbConfig
	uuid, err = dbConfig.Get("uuid")
	if err != nil {
		return nil, err
	}
	if uuid != "" {
		device.Uuid = uuid
		device.FinishBootstrapping()
	} else {
		log.Printf("New device detected, bootstrapping...")
		if uuid, err = dev.readConfigAndEnsureUuid(superConfig); err == nil {
			device.Uuid = uuid
			device.SuperConfig = superConfig
			loadPreloadedApps(appsCollection)
			device.BootstrapOrRetry()
			dev = &device
		}
	}
	return
}

// TODO
func (dev Device) GetId() {
	resin.GetDevice(dev.Uuid)
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

func (dev Device) register() error {
	return nil
}
