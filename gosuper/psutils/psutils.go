package psutils

import (
	"fmt"
	"os"
	"path"
	"regexp"
	"strconv"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/samalba/dockerclient"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/shirou/gopsutil/process"
)

//AdjustOOMPriorityByName Adjust the OOM adj value for the process' with the given name regexp
func AdjustOOMPriorityByName(procPath string, processName string, value int64) error {
	runningProcess, err := process.Pids()
	if err != nil {
		return err
	}
	var processMatch = regexp.MustCompile(processName)
	processFound := false
	for _, pid := range runningProcess {
		// Find the process with the given name
		pidProcess, _ := process.NewProcess(pid)
		pidName, _ := pidProcess.Name()
		if processMatch.MatchString(pidName) {
			processFound = true
			err := AdjustOOMPriority(procPath, int64(pid), value)
			if err != nil {
				return err
			}
		}
	}
	if processFound {
		return nil
	}
	return fmt.Errorf("No process matches: %s\n", processName)
}

//AdjustOOMPriority Adjust the OOM adj value for the process with the given pid
func AdjustOOMPriority(procPath string, pid int64, value int64) error {
	// Open the oom_score_adj file for the pid
	oomAdjFile, err := os.OpenFile(path.Clean(procPath)+"/"+strconv.FormatInt(pid, 10)+"/oom_score_adj", os.O_RDWR, os.ModeType)
	if err != nil {
		return fmt.Errorf("Unable to open OOM adjust proc file for pid: %d\n", pid)
	}
	defer oomAdjFile.Close()
	// Write to the procfile to adjust the OOM adj value.
	_, err = oomAdjFile.WriteString(strconv.FormatInt(value, 10))
	if err != nil {
		return fmt.Errorf("Unable to OOM adjust for pid: %d\n", pid)
	}
	return nil
}

//AdjustDockerOOMPriority Adjusts the OOM Adj value for the entire docker container specified by the name. This should point to root proc filesystem
func AdjustDockerOOMPriority(procPath string, connection string, containerName string, value int64) error {
	// Connect to the docker host with the connection string
	docker, err := dockerclient.NewDockerClient(connection, nil)
	if err != nil {
		return err
	}
	// Get the running containers
	containers, err := docker.ListContainers(false, false, "")
	if err != nil {
		return err
	}
	for _, container := range containers {
		containerInfo, err := docker.InspectContainer(container.Id)
		if err != nil {
			return err
		}
		err = AdjustOOMPriority(procPath, int64(containerInfo.State.Pid), value)
		if err != nil {
			return err
		}
	}
	return nil
}
