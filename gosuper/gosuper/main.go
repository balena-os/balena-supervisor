package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/gorilla/mux"
)

func pingHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintln(w, "OK")
}

//var Config UserConfig // Disabled until we use Config
var ResinDataPath string

func main() {
	fmt.Println("Resin Go Supervisor starting")
	/* Disabled until we use Config
	var err error
	Config, err = ReadConfig("/boot/config.json")
	if err != nil {
		log.Fatalf("Could not read configuration file: %v", err)
	}
	*/

	ResinDataPath = "/mnt/root/resin-data/"
	listenAddress := os.Getenv("GOSUPER_SOCKET")

	r := mux.NewRouter()
	r.HandleFunc("/ping", pingHandler)
	apiv1 := r.PathPrefix("/v1").Subrouter()

	apiv1.HandleFunc("/purge", PurgeHandler).Methods("POST")

	fmt.Println("Going to listen on " + listenAddress)
	listener, err := net.Listen("unix", listenAddress)
	if err != nil {
		log.Fatalf("Could not listen on "+listenAddress+": %v", err)
	}
	fmt.Println("Starting HTTP server")
	err = http.Serve(listener, r)
	if err != nil {
		log.Fatalf("Could not start HTTP server: %v", err)
	}
}
