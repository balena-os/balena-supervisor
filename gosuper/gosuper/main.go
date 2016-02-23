package main

import (
	"log"
	"time"

	"github.com/resin-io/resin-supervisor/gosuper/application"
	"github.com/resin-io/resin-supervisor/gosuper/config"
	"github.com/resin-io/resin-supervisor/gosuper/device"
	"github.com/resin-io/resin-supervisor/gosuper/psutils"
	"github.com/resin-io/resin-supervisor/gosuper/supermodels"
	"github.com/resin-io/resin-supervisor/gosuper/utils"
)

var ResinDataPath string = "/mnt/root/resin-data/"

func connectivityCheck() {

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

	go connectivityCheck()

	superConfig := config.GetSupervisorConfig()

	// Start OOMProtectionTimer for protecting Openvpn/Connman
	defer startOOMProtectionTimer(superConfig.HostProc, superConfig.DockerSocket).Stop()

	if err := utils.MixpanelInit(superConfig.MixpanelToken); err != nil {
		log.Printf("Failed to initialize Mixpanel client: %s", err)
	}

	appsCollection, dbConfig, err := supermodels.New(superConfig.DatabasePath)
	if err != nil {
		log.Fatalf("Failed to start database: %s", err)
	}

	theDevice, err := device.New(appsCollection, dbConfig, superConfig)
	if err != nil {
		log.Fatalf("Failed to start device bootstrapping: %s", err)
	}

	utils.MixpanelSetId(theDevice.Uuid)
	applicationManager, err := application.NewManager(appsCollection, dbConfig, theDevice, superConfig)
	if err != nil {
		log.Fatalf("Failed to initialize applications manager: %s", err)
	}
	theDevice.WaitForBootstrap()
	StartApi(superConfig.ListenPort, applicationManager)
}
