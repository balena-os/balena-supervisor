#!/bin/sh

set -o errexit

SUPERVISOR_PID=1
# Snapshot interval in seconds (default: 3600s = 1h)
INTERVAL="${INTERVAL:-3600}"

# Send a SIGUSR2 signal to the supervisor process once every INTERVAL
while true; do
    kill -USR2 "${SUPERVISOR_PID}"
    sleep "${INTERVAL}"
done