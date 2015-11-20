package main

import (
	"log"

	"resin-supervisor/gosuper/application"
	"resin-supervisor/gosuper/config"
	"resin-supervisor/gosuper/device"
	"resin-supervisor/gosuper/supermodels"
	"resin-supervisor/gosuper/utils"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func connectivityCheck() {

}

func main() {
	log.SetFlags(log.Lshortfile | log.LstdFlags)
	log.Println("Resin Supervisor starting")
	go connectivityCheck()

	superConfig := config.GetSupervisorConfig()

	if err := utils.MixpanelInit(superConfig.MixpanelToken); err != nil {
		log.Printf("Failed to initialize Mixpanel client: %s", err)
	}

	if appsCollection, dbConfig, err := supermodels.New(superConfig.DatabasePath); err != nil {
		log.Fatalf("Failed to start database: %s", err)
	} else if theDevice, err := device.New(appsCollection, dbConfig, superConfig); err != nil {
		log.Fatalf("Failed to start device bootstrapping: %s", err)
	} else {
		utils.MixpanelSetId(theDevice.Uuid)
		if applicationManager, err := application.NewManager(appsCollection, dbConfig, theDevice, superConfig); err != nil {
			log.Fatalf("Failed to initialize applications manager: %s", err)
		} else if err = StartApi(superConfig.ListenPort, applicationManager); err != nil {
			log.Printf("Failed to initialize Supervisor API: %s", err)
		}
	}
}
