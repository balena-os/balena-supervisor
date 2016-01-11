package psutils

import (
	"bufio"
	"fmt"
	"os"
	"path"
	"strconv"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/samalba/dockerclient"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/shirou/gopsutil/process"
)

//AdjustOOMPriorityByName Adjust the OOM adj value for the process' with the given name regexp
func AdjustOOMPriorityByName(procPath string, processName string, value int, ignoreIfNonZero bool) error {
	found := false
	pids, err := process.Pids()
	if err != nil {
		return err
	}
	for _, pid := range pids {
		// Find the process with the given name
		if currProcess, err := process.NewProcess(pid); err == nil {
			if name, err := currProcess.Name(); err == nil && name == processName {
				if err := AdjustOOMPriority(procPath, int(pid), value, ignoreIfNonZero); err == nil {
					found = true
				}
			}
		}
	}
	if found {
		return nil
	}
	return fmt.Errorf("No process matches: %s\n", processName)
}

//AdjustOOMPriority Adjust the OOM adj value for the process with the given pid.
func AdjustOOMPriority(procPath string, pid int, value int, ignoreIfNonZero bool) error {
	oomPath := fmt.Sprintf("%s/%d/oom_score_adj", path.Clean(procPath), pid)
	oomAdjFile, err := os.OpenFile(oomPath, os.O_RDWR, os.ModeType)
	if err != nil {
		return fmt.Errorf("Unable to open OOM adjust proc file for pid: %d\n", pid)
	}
	defer oomAdjFile.Close()
	// Read the oom_score_adj value currently set
	scanner := bufio.NewScanner(oomAdjFile)
	scanner.Split(bufio.ScanLines)
	var currentOOMString string
	for scanner.Scan() {
		currentOOMString = scanner.Text() // Read the OOMString
	}
	currentOOMValue, err := strconv.ParseInt(currentOOMString, 10, 64)
	if err != nil {
		return fmt.Errorf("Unable to read OOM adjust for pid: %d\n", pid)
	}
	if ignoreIfNonZero && currentOOMValue != 0 {
		return nil
	}
	// Write to the procfile to adjust the OOM adj value.
	if _, err = oomAdjFile.WriteString(fmt.Sprintf("%d", value)); err != nil {
		return fmt.Errorf("Unable to OOM adjust for pid: %d\n", pid)
	}
	return nil
}

//AdjustDockerOOMPriority Adjusts the OOM Adj value for the entire docker container specified by the name. This should point to root proc filesystem
func AdjustDockerOOMPriority(procPath string, connection string, containerName string, value int, ignoreIfNonZero bool) error {
	if docker, err := dockerclient.NewDockerClient(connection, nil); err != nil {
		return err
	} else if containers, err := docker.ListContainers(false, false, fmt.Sprintf(`{"name":["^/%s$"]}`, containerName)); err != nil {
		return err
	} else if containerInfo, err := docker.InspectContainer(containers[0].Id); err != nil {
		return err
	} else if err = AdjustOOMPriority(procPath, containerInfo.State.Pid, value, ignoreIfNonZero); err != nil {
		return err
	} else {
		return nil
	}
}
