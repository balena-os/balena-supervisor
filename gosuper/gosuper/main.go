package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/gorilla/mux"
	"resin-supervisor/gosuper/psutils"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func setupApi(router *mux.Router) {
	router.HandleFunc("/ping", func(writer http.ResponseWriter, request *http.Request) {
		fmt.Fprintln(writer, "OK")
	})

	apiv1 := router.PathPrefix("/v1").Subrouter()
	apiv1.HandleFunc("/ipaddr", IPAddressHandler).Methods("GET")
	apiv1.HandleFunc("/purge", PurgeHandler).Methods("POST")
	apiv1.HandleFunc("/reboot", RebootHandler).Methods("POST")
	apiv1.HandleFunc("/shutdown", ShutdownHandler).Methods("POST")
	apiv1.HandleFunc("/vpncontrol", VPNControl).Methods("POST")
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

func startOOMProtection(hostproc string, dockerSocket string, ticker *time.Ticker) {
	log.Println("Changing oom_score_adj for the supervisor container to -800")
	if err := psutils.AdjustDockerOOMPriority(hostproc, "unix://"+dockerSocket, "/resin_supervisor", -800, false); err != nil {
		log.Printf("FAILED to OOM protect supervisor container: %s\n", err)
	}
	// Code below this could be eventually deprecated after all the devices are > 5 Jan 2016 deployment as this will be handled in the HOST OS.
	log.Println("Changing oom_score_adj for openvpn and connmand to -1000 if 0, every 5 minutes")
	// Errors are not being caught here as users could have openvpn and connmand disabled.
	psutils.AdjustOOMPriorityByName(hostproc, "openvpn", -1000, true)
	psutils.AdjustOOMPriorityByName(hostproc, "connmand", -1000, true)
	go func() {
		for _ = range ticker.C {
			psutils.AdjustOOMPriorityByName(hostproc, "openvpn", -1000, true)
			psutils.AdjustOOMPriorityByName(hostproc, "connmand", -1000, true)
		}
	}()
}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Go Supervisor starting")

	// Start ticker for protecting Openvpn/Connman every 5 minutes
	ticker := time.NewTicker(time.Minute * 5)
	defer ticker.Stop()
	dockerSocket := os.Getenv("DOCKER_SOCKET")
	hostproc := os.Getenv("HOST_PROC")
	startOOMProtection(hostproc, dockerSocket, ticker)

	listenAddress := os.Getenv("GOSUPER_SOCKET")
	router := mux.NewRouter()
	setupApi(router)
	startApi(listenAddress, router)
}
