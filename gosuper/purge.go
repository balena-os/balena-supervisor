package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
)

type ApiResponse struct {
	Status string
	Error  string
}

type PurgeBody struct {
	ApplicationId string
}

func jsonResponse(w http.ResponseWriter, response interface{}, status int) {
	j, _ := json.Marshal(response)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(j)
}

func parseJsonBody(r *http.Request, dest interface{}) error {
	decoder := json.NewDecoder(r.Body)
	err := decoder.Decode(&dest)
	return err
}

func PurgeHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Println("Purging /data")
	var body PurgeBody
	err := parseJsonBody(r, &body)
	if err != nil {
		jsonResponse(w, ApiResponse{"Error", "Invalid request"}, 422)
		return
	}

	appId := body.ApplicationId
	if appId == "" {
		jsonResponse(w, ApiResponse{"Error", "applicationId is required"}, 422)
		return
	}

	// Validate that the appId is an integer
	_, err = strconv.ParseInt(appId, 10, 0)
	if err != nil {
		jsonResponse(w, ApiResponse{"Error", "Invalid applicationId"}, 422)
		return
	}

	directory := ResinDataPath + appId

	err = os.RemoveAll(directory)

	if err != nil {
		jsonResponse(w, ApiResponse{"Error", err.Error()}, 500)
		return
	}

	err = os.Mkdir(directory, 0755)
	if err != nil {
		jsonResponse(w, ApiResponse{"Error", err.Error()}, 500)
		return
	}

	jsonResponse(w, ApiResponse{"OK", ""}, 200)

}
