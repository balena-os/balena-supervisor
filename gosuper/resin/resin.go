package resin

// TODO: Most of this package...

import (
	"errors"

	pinejs "resin-supervisor/gosuper/Godeps/_workspace/src/github.com/resin-io/pinejs-client-go"
	//"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/resin-io/pinejs-client-go/resin"

	"resin-supervisor/gosuper/supermodels"
)

type Device struct {
}

type Client struct {
	BaseApiEndpoint string
	pinejs.Client
}

func NewClient(apiEndpoint, apiKey string) (client *Client) {
	client.Client = *(pinejs.NewClient(apiEndpoint+"/ewa", apiKey))
	client.BaseApiEndpoint = apiEndpoint
	return
}

func (client *Client) RegisterDevice(dev *map[string]interface{}) (err error) {
	err = client.Create(dev)
	return
}

func (client *Client) GetDevice(uuid string) (dev map[string]interface{}, err error) {
	var devices []map[string]interface{}
	devices[0] = make(map[string]interface{})
	devices[0]["pinejs"] = "device"
	err = client.Get(&devices, pinejs.NewQueryOptions(pinejs.Filter, `uuid eq "`+uuid+`"`)...)
	if len(devices) == 0 {
		err = errors.New("Device not found")
	} else {
		dev = devices[0]
	}
	return
}

func (client *Client) GetApps() (apps []supermodels.App, err error) {
	return
}

func (client *Client) UpdateDevice(dev *map[string]interface{}) (err error) {
	return
}

// This one has to use BaseApiEndpoint and do the request without the pinejs client.
func (client *Client) GetEnvironment(appId string, deviceId string) (env map[string]string, err error) {
	return
}
