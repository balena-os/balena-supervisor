package main

import (
	"strings"
	"testing"
)

func TestReadConfig(t *testing.T) {
	if config, err := ReadConfig("config_for_test.json"); err != nil {
		t.Error(err)
	} else if !strings.EqualFold(config.ApplicationId, "1939") || !strings.EqualFold(config.ApiKey, "SuperSecretAPIKey") {
		t.Error("Config not parsed correctly")
	}
}
