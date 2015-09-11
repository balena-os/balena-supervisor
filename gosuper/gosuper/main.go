package main

import (
	"log"

	"resin-supervisor/gosuper/application"
	"resin-supervisor/gosuper/device"
	"resin-supervisor/gosuper/supermodels"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func connectivityCheck() {

}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Supervisor starting")

	config := GetSupervisorConfig()
	go connectivityCheck()
	if appsCollection, dbConfig, err := supermodels.Initialize(); err != nil {
		log.Fatal("Failed to start database")
	} else if dev, err := device.Initialize(appsCollection, dbConfig); err != nil {
		log.Fatal("Failed to start device bootstrapping")
	} else if apps, err := application.Initialize(appsCollection, dbConfig, dev); err != nil {
		log.Fatal("Failed to initialize applications manager")
	} else if err = StartApi(config.ListenPort, apps); err != nil {
		log.Fatal("Failed to initialize Supervisor API")
	}
}
