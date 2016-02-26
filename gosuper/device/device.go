package device

// TODO: implement function to get OS version
// TODO: implement UpdateState (using dev.ResinClient.UpdateDevice)
// TODO: implement ApplyBootConfig

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"sync"
	"time"

	"resin-supervisor/gosuper/config"
	"resin-supervisor/gosuper/resin"
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
	Config        config.UserConfig
	DbConfig      *supermodels.Config
	ResinClient   *resin.Client
	SuperConfig   config.SupervisorConfig
}

func (dev Device) readConfigAndEnsureUuid() (uuid string, conf config.UserConfig, err error) {
	if conf, err = config.ReadConfig(config.DefaultConfigPath); err != nil {
	} else if conf.Uuid != "" {
		uuid = conf.Uuid
	} else if uuid, err = utils.RandomHexString(uuidByteLength); err != nil {
		conf.Uuid = uuid
		err = config.WriteConfig(conf, config.DefaultConfigPath)
	}
	if err != nil {
		time.Sleep(time.Duration(dev.SuperConfig.BootstrapRetryDelay) * time.Millisecond)
		return dev.readConfigAndEnsureUuid()
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

// TODO use dev.ResinClient.RegisterDevice
func (dev *Device) register() (registeredAt int, deviceId int, err error) {
	return
}

func (dev *Device) bootstrap() (err error) {
	if dev.Config.DeviceType == "" {
		dev.Config.DeviceType = "raspberry-pi"
	}
	if dev.Config.RegisteredAt == 0 {
		if registeredAt, deviceId, err := dev.register(); err == nil {
			dev.Config.RegisteredAt = float64(registeredAt)
			dev.Config.DeviceId = float64(deviceId)
			if err = config.WriteConfig(dev.Config, config.DefaultConfigPath); err != nil {
				return err
			}
		} else {
			return err
		}
	}

	config.SaveToDB(dev.Config, dev.DbConfig)
	return
}

func (dev *Device) BootstrapOrRetry() {
	utils.MixpanelTrack("Device bootstrap", nil)
	if err := dev.bootstrap(); err != nil {
		log.Printf("Device bootstrap failed, retrying: %s", err)
		time.AfterFunc(time.Duration(dev.SuperConfig.BootstrapRetryDelay)*time.Millisecond, dev.BootstrapOrRetry)
	}
}

func New(appsCollection *supermodels.AppsCollection, dbConfig *supermodels.Config, superConfig config.SupervisorConfig) (dev *Device, err error) {
	device := Device{}
	var uuid string
	var conf config.UserConfig
	device.DbConfig = dbConfig
	dev.SuperConfig = superConfig
	if uuid, err = dbConfig.Get("uuid"); err != nil {
	} else if uuid != "" {
		if apikey, err := dbConfig.Get("apikey"); err == nil {
			device.Uuid = uuid
			device.ResinClient = resin.NewClient(superConfig.ApiEndpoint, apikey)
			device.FinishBootstrapping()
		} else {
			// This should *never* happen
			log.Fatalf("Device is bootstrapped, but could not get apikey from DB: %s", err)
		}
	} else {
		log.Printf("New device detected, bootstrapping...")
		if uuid, conf, err = device.readConfigAndEnsureUuid(); err == nil {
			device.Uuid = uuid
			device.Config = conf
			device.ResinClient = resin.NewClient(superConfig.ApiEndpoint, conf.ApiKey)
			loadPreloadedApps(appsCollection)
			device.BootstrapOrRetry()
			dev = &device
		}
	}
	return
}

func (dev Device) GetId() (id int, err error) {
	remoteDev, err := dev.ResinClient.GetDevice(dev.Uuid)
	if err != nil {
		id = remoteDev.Id
	}
	return
}

func (dev Device) WaitForBootstrap() {
	dev.bootstrapLock.Lock()
	if dev.Bootstrapped {
		dev.bootstrapLock.Unlock()
	} else {
		dev.waitChannels = append(dev.waitChannels, make(chan bool))
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
