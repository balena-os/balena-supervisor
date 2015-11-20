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

func bootstrapOrRetry() {

}

func New(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config, superConfig config.SupervisorConfig) (dev *Device, err error) {
	device := Device{}
	var uuid string
	if uuid, err = dbConfig.Get("uuid"); err != nil {
	} else if uuid != "" {
		device.Uuid = uuid
		device.finishBootstrapping()
	} else {
		log.Printf("New device detected, bootstrapping...")
		if uuid, err = readConfigAndEnsureUuid(superConfig); err == nil {
			device.Uuid = uuid
			loadPreloadedApps(appsCollection)
			bootstrapOrRetry()
			dev = &device
		}
	}
	return
}

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

func (dev Device) finishBootstrapping() {
	dev.bootstrapLock.Lock()
	dev.Bootstrapped = true
	for _, c := range dev.waitChannels {
		c <- true
	}
	dev.bootstrapLock.Unlock()
}
