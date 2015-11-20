package main

import (
	"log"

	"resin-supervisor/gosuper/application"
	"resin-supervisor/gosuper/config"
	"resin-supervisor/gosuper/device"
	"resin-supervisor/gosuper/supermodels"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func connectivityCheck() {

}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Supervisor starting")

	superConfig := config.GetSupervisorConfig()
	go connectivityCheck()
	if appsCollection, dbConfig, err := supermodels.New(superConfig.DatabasePath); err != nil {
		log.Fatal("Failed to start database")
	} else if theDevice, err := device.New(appsCollection, dbConfig); err != nil {
		log.Fatal("Failed to start device bootstrapping")
	} else if applicationManager, err := application.NewManager(appsCollection, dbConfig, theDevice); err != nil {
		log.Fatal("Failed to initialize applications manager")
	} else if err = StartApi(superConfig.ListenPort, applicationManager); err != nil {
		log.Fatal("Failed to initialize Supervisor API")
	}
}
