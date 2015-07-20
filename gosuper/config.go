package main

import (
	"encoding/json"
	"os"
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

	f, err := os.Open(path)
	if err != nil {
		return config, err
	}
	data := make([]byte, 1000)

	count, err := f.Read(data)

	if err != nil {
		return config, err
	}

	err = json.Unmarshal(data[:count], &config)

	return config, err
}
