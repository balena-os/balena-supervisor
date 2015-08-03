package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
)

type ApiResponse struct {
	Status string
	Error  string
}

type PurgeBody struct {
	ApplicationId string
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

func PurgeHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Purging /data")
	var body PurgeBody

	sendResponse := func(statusMsg, errorMsg string, statusCode int) {
		jsonResponse(writer, ApiResponse{statusMsg, errorMsg}, statusCode)
	}
	sendError := func(err error) {
		sendResponse("Error", err.Error(), http.StatusInternalServerError)
	}
	sendBadRequest := func(errorMsg string) {
		sendResponse("Error", errorMsg, http.StatusBadRequest)
	}

	if err := parseJsonBody(&body, request); err != nil {
		sendBadRequest("Invalid request")
	} else if appId := body.ApplicationId; appId == "" {
		sendBadRequest("applicationId is required")
	} else if !IsValidAppId(appId) {
		sendBadRequest(fmt.Sprintf("Invalid applicationId '%s'", appId))
	} else if _, err = os.Stat(ResinDataPath + appId); err != nil {
		if os.IsNotExist(err) {
			sendBadRequest(fmt.Sprintf("Invalid applicationId '%s': Directory does not exist", appId))
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
