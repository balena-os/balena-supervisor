package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/gorilla/mux"
	"resin-supervisor/gosuper/application"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func startConnectivityCheck() {

}

func supervisorStart() {

}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Supervisor starting")

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
