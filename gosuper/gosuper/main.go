package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/mux"
	"resin-supervisor/gosuper/psutils"
)

var ResinDataPath string = "/mnt/root/resin-data/"

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

func startOOMProtectionTimer(hostproc string, dockerSocket string) *time.Ticker {
	ticker := time.NewTicker(time.Minute * 5) //Timer runs every 5 minutes
	procs := &psutils.Procs{hostproc}
	log.Println("Changing oom_score_adj for the supervisor container to -800")
	if err := procs.AdjustDockerOOMPriority("unix://"+dockerSocket, "resin_supervisor", -800, false); err != nil {
		log.Printf("FAILED to OOM protect supervisor container: %s\n", err)
	}
	// Code below this could be eventually deprecated after all the devices are > 5 Jan 2016 deployment as this will be handled in the HOST OS.
	log.Println("Changing oom_score_adj for openvpn and connmand to -1000 if 0, every 5 minutes")
	// Errors are not being caught here as users could have openvpn and connmand disabled.
	procs.AdjustOOMPriorityByName("openvpn", -1000, true)
	procs.AdjustOOMPriorityByName("connmand", -1000, true)
	go func() {
		for _ = range ticker.C {
			procs.AdjustOOMPriorityByName("openvpn", -1000, true)
			procs.AdjustOOMPriorityByName("connmand", -1000, true)
		}
	}()
	return ticker
}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Go Supervisor starting")

	// Start OOMProtectionTimer for protecting Openvpn/Connman
	dockerSocket := os.Getenv("DOCKER_SOCKET")
	hostproc := os.Getenv("HOST_PROC")
	if dataPathEnv := os.Getenv("RESIN_DATA_PATH"); dataPathEnv != "" {
		ResinDataPath = "/mnt/root" + dataPathEnv
	}
	defer startOOMProtectionTimer(hostproc, dockerSocket).Stop()

	listenAddress := os.Getenv("GOSUPER_SOCKET")
	router := mux.NewRouter()
	setupApi(router)
	startApi(listenAddress, router)
}
