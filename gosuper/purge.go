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

func jsonResponse(w http.ResponseWriter, response interface{}, status int) {
	j, _ := json.Marshal(response)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(j)
}

func PurgeHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Println("Purging /data")

	appId := r.FormValue("applicationId")
	if appId == "" {
		jsonResponse(w, ApiResponse{"Error", "applicationId is required"}, 422)
		return
	}

	// Validate that the appId is an integer
	_, err := strconv.ParseInt(appId, 10, 0)
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
