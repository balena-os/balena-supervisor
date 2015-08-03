package main

import (
	"encoding/json"
	"io/ioutil"
)

type UserConfig struct {
	ApplicationId string
	ApiKey        string
	UserId        string
	Username      string
	DeviceType    string
	Uuid          string
	RegisteredAt  float64
	DeviceId      float64
}

func ReadConfig(path string) (config UserConfig, err error) {
	if data, err := ioutil.ReadFile(path); err == nil {
		err = json.Unmarshal(data, &config)
	}

	return
}
