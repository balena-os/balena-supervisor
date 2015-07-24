package supertest

import (
	"net/http"
	"os"
	"testing"
)

func TestPing(t *testing.T) {
	supervisorIP := os.getEnv("SUPERVISOR_IP")
	if supervisorIP == "" {
		t.Error("Supervisor IP not set")
	}

	address := "http://"+ supervisorIP +":48484"

	request, err := http.NewRequest("GET", address+"/ping?apikey=bananas", nil)

	if err != nil {
		t.Error(err)
	}

	res, err := http.DefaultClient.Do(request)

	if err != nil {
		t.Error(err)
	}

	if res.StatusCode != 200 {
		t.Errorf("Expected 200, got %d", res.StatusCode)
	}
}
