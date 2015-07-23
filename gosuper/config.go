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

func ReadConfig(path string) (UserConfig, error) {

	var config UserConfig

	data, err := ioutil.ReadFile(path)

	if err != nil {
		return config, err
	}

	err = json.Unmarshal(data, &config)

	return config, err
}
