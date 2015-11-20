package config

import (
	"os"
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

func TestGetSupervisorConfig(t *testing.T) {
	os.Setenv("API_ENDPOINT", "https://api.resinstaging.io")
	os.Setenv("PUBNUB_SUBSCRIBE_KEY", "hi")
	os.Setenv("APP_UPDATE_POLL_INTERVAL", "10")
	os.Setenv("BOOTSTRAP_RETRY_DELAY", "")
	config := GetSupervisorConfig()
	if !strings.EqualFold(config.ApiEndpoint, "https://api.resinstaging.io") || !strings.EqualFold(config.Pubnub.SubscribeKey, "hi") || config.AppUpdatePollInterval != 10 || config.BootstrapRetryDelay != 30000 {
		t.Errorf("Supervisor Config not parsed correctly %+v", config)
	}
}
