package resin

import (
	"errors"
	"path"
	"strconv"
	"strings"

	pinejs "resin-supervisor/gosuper/Godeps/_workspace/src/github.com/resin-io/pinejs-client-go"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/resin-io/pinejs-client-go/resin"

	"resin-supervisor/gosuper/supermodels"
)

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
	(*dev)["pinejs"] = "device"
	return client.Create(dev)
}

func (client *Client) GetDevice(uuid string) (dev map[string]interface{}, err error) {
	var devices []map[string]interface{}
	devices[0] = make(map[string]interface{})
	devices[0]["pinejs"] = "device"
	if err = client.Get(&devices, pinejs.NewQueryOptions(pinejs.Filter, "uuid eq '"+uuid+"'")...); err != nil {
		return dev, err
	} else if len(devices) == 0 {
		err = errors.New("Device not found")
	} else {
		dev = devices[0]
	}
	return dev, err
}

func (client *Client) GetApps(uuid, registryEndpoint, deviceId string) (apps []supermodels.App, err error) {
	var remoteApps []resin.Application
	err = client.List(&remoteApps, pinejs.NewQueryOptions(pinejs.Filter, `commit ne null`, pinejs.Filter, "device/any(d:d/uuid eq'"+uuid+"')", pinejs.Select, []string{"id", "commit", "git_repository"})...)
	if err != nil {
		return apps, err
	}
	for _, app := range remoteApps {
		env, err := client.getEnvironment(strconv.Itoa(app.Id), deviceId)
		if err != nil {
			return apps, err
		}
		imageId := registryEndpoint + "/" + strings.TrimSuffix(path.Base(app.GitRepository), ".git") + "/" + app.Commit
		apps = append(apps, supermodels.App{AppId: app.Id, Commit: app.Commit, ImageId: imageId, Env: env})
	}

	return apps, err
}

func (client *Client) UpdateDevice(dev *map[string]interface{}, deviceId string) (err error) {
	(*dev)["id"] = deviceId
	(*dev)["pinejs"] = "device"
	return client.Patch(dev)
}

// TODO implement getEnvironment
// This one has to use BaseApiEndpoint and do the request without the pinejs client.
func (client *Client) getEnvironment(appId string, deviceId string) (env map[string]string, err error) {
	return
}
