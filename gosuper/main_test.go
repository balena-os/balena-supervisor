package main

import (
	"io/ioutil"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestPurge(t *testing.T) {
	appId := "1"
	req, _ := http.NewRequest("POST", "/api/v1/purge", strings.NewReader("applicationId="+appId))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; param=value")

	w := httptest.NewRecorder()

	ResinDataPath = "test-data/"

	dataPath := ResinDataPath + appId

	err := os.MkdirAll(dataPath, 0755)
	if err != nil {
		t.Error("Could not create test directory for purge")
	}

	PurgeHandler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Purge didn't return %v", http.StatusOK)
	}
	if !strings.EqualFold(w.Body.String(), `{"Status":"OK","Error":""}`) {
		t.Errorf("Purge response didn't match the expected JSON, got: %s", w.Body.String())
	}

	dirContents, err := ioutil.ReadDir(dataPath)
	if err != nil {
		t.Errorf("Could not read the data path after purge: %s", err)
	}
	if len(dirContents) > 0 {
		t.Error("Data directory not empty after purge")
	}
}

func TestReadConfig(t *testing.T) {
	config, err := ReadConfig("config_for_test.json")
	if err != nil {
		t.Error(err)
	}

	if !strings.EqualFold(config.ApplicationId, "1939") || !strings.EqualFold(config.ApiKey, "SuperSecretAPIKey") {
		t.Error("Config not parsed correctly")
	}
}
