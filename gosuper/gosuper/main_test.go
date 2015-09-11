package main

import (
	"io/ioutil"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

var purgeTests = []struct {
	JsonInput    string
	AppId        string
	JsonResponse string
	IsSuccess    bool
	HttpStatus   int
}{
	{`{"applicationId": "1"}`, "1", `{"Data":"OK","Error":""}`, true, http.StatusOK},
	{`{"applicationId": 1}`, "1", `{"Data":"OK","Error":""}`, true, http.StatusOK},
	{`{"applicationId": "hi"}`, "1", `{"Data":"Error","Error":"Invalid applicationId 'hi'"}`, false, http.StatusBadRequest},
	{`{"applicationId": "2"}`, "1", `{"Data":"Error","Error":"Invalid applicationId '2': Directory does not exist"}`, false, http.StatusNotFound},
	{`{}`, "1", `{"Data":"Error","Error":"applicationId is required"}`, false, http.StatusBadRequest},
}

func TestPurge(t *testing.T) {
	for i, testCase := range purgeTests {
		t.Logf("Testing Purge case #%d", i)
		request, err := http.NewRequest("POST", "/v1/purge", strings.NewReader(testCase.JsonInput))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded; param=value")
		writer := httptest.NewRecorder()
		ResinDataPath = "test-data/"
		dataPath := ResinDataPath + testCase.AppId
		testFile := dataPath + "/test"

		if err = os.MkdirAll(dataPath, 0755); err != nil {
			t.Fatal("Could not create test directory for purge")
		} else if err = ioutil.WriteFile(testFile, []byte("test"), 0777); err != nil {
			t.Fatal("Could not create test file for purge")
		}

		PurgeHandler(writer, request)

		if writer.Code != testCase.HttpStatus {
			t.Errorf("Purge didn't return %v, got %v", testCase.HttpStatus, writer.Code)
		}
		if !strings.EqualFold(writer.Body.String(), testCase.JsonResponse) {
			t.Errorf(`Purge response didn't match the expected JSON, expected "%s" got: "%s"`, testCase.JsonResponse, writer.Body.String())
		}

		if dirContents, err := ioutil.ReadDir(dataPath); err != nil {
			t.Errorf("Could not read the data path after purge: %s", err)
		} else {
			fileCount := len(dirContents)
			if fileCount > 0 && testCase.IsSuccess {
				t.Error("Data directory not empty after purge")
			} else if fileCount == 0 && !testCase.IsSuccess {
				t.Error("Data directory empty after purge (but it failed)")
			}
		}
	}
}

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
