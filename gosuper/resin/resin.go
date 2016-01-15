package resin

import (
	pinejs "resin-supervisor/gosuper/Godeps/_workspace/src/github.com/resin-io/pinejs-client-go"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/resin-io/pinejs-client-go/resin"

	"resin-supervisor/gosuper/supermodels"
)

type Device resin.Device

func Init() {
	pinejs.NewClient("", "")
}

func RegisterDevice(dev Device) (err error) {

}

func GetDevice(uuid string) (dev Device, err error) {

}

func GetApps() (apps []supermodels.Application, err error) {

}

func UpdateDevice(dev Device) (err error) {

}

func GetEnvironment(appId string, deviceId string) (env map[string]string, err error) {

}
