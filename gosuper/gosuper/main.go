package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"github.com/gorilla/mux"
)

func setupApi(router *mux.Router) {
	router.HandleFunc("/ping", func(writer http.ResponseWriter, request *http.Request) {
		fmt.Fprintln(writer, "OK")
	})

	apiv1 := router.PathPrefix("/v1").Subrouter()
	apiv1.HandleFunc("/reboot", RebootHandler).Methods("POST")
	apiv1.HandleFunc("/shutdown", ShutdownHandler).Methods("POST")
	apiv1.HandleFunc("/vpncontrol", VPNControl).Methods("POST")
	apiv1.HandleFunc("/vpncontrol", VPNStatus).Methods("GET")
	apiv1.HandleFunc("/log-to-display", LogToDisplayControl).Methods("POST")
	apiv1.HandleFunc("/log-to-display", LogToDisplayStatus).Methods("GET")
	apiv1.HandleFunc("/restart-service", RestartService).Methods("POST")
}

func startApi(listenAddress string, router *mux.Router) {
	if listener, err := net.Listen("unix", listenAddress); err != nil {
		log.Fatalf("Could not listen on %s: %v", listenAddress, err)
	} else {
		log.Printf("Starting HTTP server on %s\n", listenAddress)
		if err = http.Serve(listener, router); err != nil {
			log.Fatalf("Could not start HTTP server: %v", err)
		}
	}
}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Go Supervisor starting")
	listenAddress := os.Getenv("GOSUPER_SOCKET")
	router := mux.NewRouter()
	setupApi(router)
	startApi(listenAddress, router)
}
