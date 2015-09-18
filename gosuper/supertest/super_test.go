package supertest

import (
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"

	gosuper "resin-supervisor/gosuper/gosuper"
)

var supervisorAddress string
var config gosuper.UserConfig

func TestMain(m *testing.M) {
	var err error
	if gopath := os.Getenv("GOPATH"); gopath == "" {
		log.Fatal("GOPATH is not set - where are you running this?")
	} else if supervisorIP := os.Getenv("SUPERVISOR_IP"); supervisorIP == "" {
		log.Fatal("Supervisor IP not set - is it running?")
	} else if config, err = gosuper.ReadConfig(gopath + "/src/resin-supervisor/gosuper/config.json"); err != nil {
		log.Fatal(err)
	} else {
		supervisorAddress = "http://" + supervisorIP + ":48484"
		os.Exit(m.Run())
	}
}

func TestPing(t *testing.T) {
	if request, err := http.NewRequest("GET", supervisorAddress+"/ping?apikey=bananas", nil); err != nil {
		t.Fatal(err)
	} else if response, err := http.DefaultClient.Do(request); err != nil {
		t.Fatal(err)
	} else if response.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", response.StatusCode)
	}
}

func TestPurge(t *testing.T) {
	appId := config.ApplicationId
	dataPath := "/resin-data/" + appId

	if err := ioutil.WriteFile(dataPath+"/test", []byte("test"), 0777); err != nil {
		t.Fatal("Could not create test file for purge")
	} else if request, err := http.NewRequest("POST", supervisorAddress+"/v1/purge?apikey=bananas", strings.NewReader(`{"appId": "`+appId+`"}`)); err != nil {
		t.Fatal(err)
	} else {
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		defer response.Body.Close()
		if err != nil {
			t.Fatal(err)
		} else if response.StatusCode != http.StatusOK {
			t.Errorf("Expected 200, got %d", response.StatusCode)
			if contents, err := ioutil.ReadAll(response.Body); err != nil {
				t.Fatal(err)
			} else {
				t.Fatalf("Response: %s", contents)
			}
		} else {
			if contents, err := ioutil.ReadAll(response.Body); err != nil {
				t.Fatal(err)
			} else if !strings.EqualFold(string(contents), `{"Data":"OK","Error":""}`) {
				t.Errorf("Purge response didn't match the expected JSON, got: %s", contents)
			}
			if dirContents, err := ioutil.ReadDir(dataPath); err != nil {
				t.Errorf("Could not read the data path after purge: %s", err)
			} else if len(dirContents) > 0 {
				t.Error("Data directory not empty after purge")
			}
		}
	}
}
