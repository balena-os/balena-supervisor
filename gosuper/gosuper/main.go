package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/gorilla/mux"
	"resin-supervisor/gosuper/application"
	"resin-supervisor/gosuper/psutils"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func startConnectivityCheck() {

}

func supervisorStart() {

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
	defer startOOMProtectionTimer(hostproc, dockerSocket).Stop()

	config := GetSupervisorConfig()
	startConnectivityCheck()
	if db, err := InitDatabase(); err != nil {
		log.Fatal("Failed to start database")
	} else if uuid, bootstrapper, err := Booststrap(db); err != nil {
		log.Fatal("Failed to bootstrap device")
	} else if apps, err := application.Initialize(uuid, db); err != nil {
		log.Fatal("Failed to initialize applications manager")
	} else if api, err := startApi(config.ListenAddress, apps); err != nil {
		log.Fatal("Failed to initialize Supervisor API")
	}
}
