package main

import (
	"log"
	"os"
	"os/signal"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/samalba/dockerclient"
	"syscall"
)

func eventCallback(e *dockerclient.Event, ec chan error, args ...interface{}) {
	log.Println(e)
}

var (
	client *dockerclient.DockerClient
)

func waitForInterrupt() {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGQUIT)
	for _ = range sigChan {
		client.StopAllMonitorEvents()
		os.Exit(0)
	}
}

func main() {
	docker, err := dockerclient.NewDockerClient(os.Getenv("DOCKER_HOST"), nil)
	if err != nil {
		log.Fatal(err)
	}

	client = docker

	client.StartMonitorEvents(eventCallback, nil)

	waitForInterrupt()
}
