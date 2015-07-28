package supertest

import (
	"io/ioutil"
	"net/http"
	"os"
	"strings"
	"testing"

	gosuper "resin-supervisor/gosuper"
)

func TestPing(t *testing.T) {
	supervisorIP := os.Getenv("SUPERVISOR_IP")
	if supervisorIP == "" {
		t.Fatal("Supervisor IP not set - is it running?")
	}

	address := "http://" + supervisorIP + ":48484"

	request, err := http.NewRequest("GET", address+"/ping?apikey=bananas", nil)

	if err != nil {
		t.Fatal(err)
	}

	res, err := http.DefaultClient.Do(request)

	if err != nil {
		t.Fatal(err)
	}

	if res.StatusCode != 200 {
		t.Fatalf("Expected 200, got %d", res.StatusCode)
	}
}

func TestPurge(t *testing.T) {
	supervisorIP := os.Getenv("SUPERVISOR_IP")
	if supervisorIP == "" {
		t.Fatal("Supervisor IP not set - is it running?")
	}

	address := "http://" + supervisorIP + ":48484"

	gopath := os.Getenv("GOPATH")

	config, err := gosuper.ReadConfig(gopath + "/src/resin-supervisor/config.json")
	if err != nil {
		t.Fatal(err)
	}

	appId := config.ApplicationId

	dataPath := "/resin-data/" + appId
	err = ioutil.WriteFile(dataPath+"/test", []byte("test"), 777)
	if err != nil {
		t.Error("Could not create test file for purge")
	}

	request, err := http.NewRequest("POST", address+"/v1/purge?apikey=bananas", strings.NewReader(`{"appId": "`+appId+`"}`))
	request.Header.Set("Content-Type", "application/json")

	if err != nil {
		t.Fatal(err)
	}

	client := &http.Client{}
	res, err := client.Do(request)

	if err != nil {
		t.Fatal(err)
	}

	if res.StatusCode != 200 {
		t.Fatalf("Expected 200, got %d", res.StatusCode)
	}

	defer res.Body.Close()
	contents, err := ioutil.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.EqualFold(string(contents), `{"Status":"OK","Error":""}`) {
		t.Errorf("Purge response didn't match the expected JSON, got: %s", contents)
	}

	dirContents, err := ioutil.ReadDir(dataPath)
	if err != nil {
		t.Errorf("Could not read the data path after purge: %s", err)
	}
	if len(dirContents) > 0 {
		t.Error("Data directory not empty after purge")
	}
}
