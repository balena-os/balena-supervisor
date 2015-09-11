package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"resin-supervisor/gosuper/systemd"
)

type ApiResponse struct {
	Status string
	Error  string
}

type PurgeBody struct {
	ApplicationId interface{}
}

func jsonResponse(writer http.ResponseWriter, response interface{}, status int) {
	jsonBody, err := json.Marshal(response)
	if err != nil {
		log.Printf("Could not marshal JSON for %+v\n", response)
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	writer.Write(jsonBody)
}

func parseJsonBody(destination interface{}, request *http.Request) error {
	decoder := json.NewDecoder(request.Body)
	return decoder.Decode(&destination)
}

func parsePurgeBody(request *http.Request) (appId string, err error) {
	var body PurgeBody
	if err = parseJsonBody(&body, request); err != nil {
		return
	}
	switch v := body.ApplicationId.(type) {
	case string:
		appId = v
	case float64:
		if v != 0 {
			appId = strconv.Itoa(int(v))
		}
	default:
		log.Printf("Invalid appId type %T\n", v)
	}
	return
}

func responseSender(writer http.ResponseWriter) func(string, string, int) {
	return func(statusMsg, errorMsg string, statusCode int) {
		jsonResponse(writer, ApiResponse{statusMsg, errorMsg}, statusCode)
	}
}

func PurgeHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Purging /data")

	sendResponse := responseSender(writer)
	sendError := func(err error) {
		sendResponse("Error", err.Error(), http.StatusInternalServerError)
	}
	sendBadRequest := func(errorMsg string) {
		sendResponse("Error", errorMsg, http.StatusBadRequest)
	}

	if appId, err := parsePurgeBody(request); err != nil {
		sendBadRequest("Invalid request")
	} else if appId == "" {
		sendBadRequest("applicationId is required")
	} else if !IsValidAppId(appId) {
		sendBadRequest(fmt.Sprintf("Invalid applicationId '%s'", appId))
	} else if _, err = os.Stat(ResinDataPath + appId); err != nil {
		if os.IsNotExist(err) {
			sendResponse("Error", fmt.Sprintf("Invalid applicationId '%s': Directory does not exist", appId), http.StatusNotFound)
		} else {
			sendError(err)
		}
	} else if err = os.RemoveAll(ResinDataPath + appId); err != nil {
		sendError(err)
	} else if err = os.Mkdir(ResinDataPath+appId, 0755); err != nil {
		sendError(err)
	} else {
		sendResponse("OK", "", http.StatusOK)
	}
}

func inASecond(theFunc func()) {
	time.Sleep(time.Duration(time.Second))
	theFunc()
}

func RebootHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Rebooting")

	sendResponse := responseSender(writer)
	sendResponse("OK", "", http.StatusAccepted)
	go inASecond(func() { systemd.Logind.Reboot(false) })
}

func ShutdownHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Shutting down")

	sendResponse := responseSender(writer)
	sendResponse("OK", "", http.StatusAccepted)
	go inASecond(func() { systemd.Logind.PowerOff(false) })
}
