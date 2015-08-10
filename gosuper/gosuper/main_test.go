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
	request, err := http.NewRequest("POST", "/v1/purge", strings.NewReader(`{"applicationId": "`+appId+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded; param=value")
	writer := httptest.NewRecorder()
	ResinDataPath = "test-data/"
	dataPath := ResinDataPath + appId

	if err = os.MkdirAll(dataPath, 0755); err != nil {
		t.Fatal("Could not create test directory for purge")
	} else if err = ioutil.WriteFile(dataPath+"/test", []byte("test"), 0777); err != nil {
		t.Fatal("Could not create test file for purge")
	}

	PurgeHandler(writer, request)

	if writer.Code != http.StatusOK {
		t.Errorf("Purge didn't return %v", http.StatusOK)
	}
	if !strings.EqualFold(writer.Body.String(), `{"Status":"OK","Error":""}`) {
		t.Errorf("Purge response didn't match the expected JSON, got: %s", writer.Body.String())
	}

	if dirContents, err := ioutil.ReadDir(dataPath); err != nil {
		t.Errorf("Could not read the data path after purge: %s", err)
	} else if len(dirContents) > 0 {
		t.Error("Data directory not empty after purge")
	}
}

func TestReadConfig(t *testing.T) {
	if config, err := ReadConfig("config_for_test.json"); err != nil {
		t.Error(err)
	} else if !strings.EqualFold(config.ApplicationId, "1939") || !strings.EqualFold(config.ApiKey, "SuperSecretAPIKey") {
		t.Error("Config not parsed correctly")
	}
}
