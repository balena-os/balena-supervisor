#!/bin/bash
CONTAINER_PID=$(docker inspect --format '{{if .State.Running}}{{.State.Pid}}{{end}}' $1)
if [ -z $CONTAINER_PID ]; then
	read -p "Application must be running for a terminal to be started."
else
	nsenter --target $CONTAINER_PID --mount --uts --ipc --net --pid bash
fi
