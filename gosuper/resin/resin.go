package resin

// This is a big TODO

import (
	pinejs "github.com/resin-io/pinejs-client-go"
	"github.com/resin-io/pinejs-client-go/resin"

	"github.com/resin-io/resin-supervisor/gosuper/supermodels"
)

type Device resin.Device

type Client pinejs.Client

func NewClient(apiEndpoint, apiKey string) (client *Client) {
	client = (*Client)(pinejs.NewClient(apiEndpoint, apiKey))
	return
}

func (client *Client) RegisterDevice(dev *Device) (err error) {
	err = (*pinejs.Client)(client).Create(dev)
	return
}

func (client *Client) GetDevice(uuid string) (dev *Device, err error) {
	var device Device
	dev = &device
	err = (*pinejs.Client)(client).Get(dev, pinejs.NewQueryOptions(pinejs.Filter, `uuid eq "`+uuid+`"`)...)
	return
}

func RegisterDevice(dev Device) (err error) {
	return nil
}

func GetDevice(uuid string) (dev Device, err error) {
	return Device{}, nil
}

func GetApps() (apps []supermodels.App, err error) {
	return nil, nil
}

func UpdateDevice(dev Device) (err error) {
	return nil
}

func GetEnvironment(appId string, deviceId string) (env map[string]string, err error) {
	return nil, nil
}
