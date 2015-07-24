package main

import (
	"fmt"
	"net"
	"net/http"
	"os"

	"resin-supervisor/Godeps/_workspace/src/github.com/gorilla/mux"
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
		return
	}
	*/

	ResinDataPath = "/resin-data/"
	laddr := os.Getenv("GOSUPER_SOCKET")

	r := mux.NewRouter()
	r.HandleFunc("/ping", pingHandler)
	apiv1 := r.PathPrefix("/v1").Subrouter()

	apiv1.HandleFunc("/purge", PurgeHandler).Methods("POST")

	listener, err := net.Listen("unix", laddr)
	if err != nil {
		fmt.Println("Could not listen on " + laddr)
		return
	}
	err = http.Serve(listener, r)
	if err != nil {
		fmt.Println("Could not start HTTP server")
		return
	}
}
