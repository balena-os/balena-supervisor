package psutils

import (
	"fmt"
	"io/ioutil"
	"log"
	"path"
	"strconv"
	"strings"

	"github.com/samalba/dockerclient"
	"github.com/shirou/gopsutil/process"
)

// Procs - psutils functions associated with the ProcfsPath
type Procs struct {
	ProcfsPath string
}

// parseInt - Parse integer from string.
func parseInt(str string) (int, error) {
	// strconv chokes on whitespace, go figure.
	trimmed := strings.TrimSpace(str)
	return strconv.Atoi(trimmed)
}

//AdjustOOMPriorityByName Adjust the OOM adj value for the process' with the given name regexp
func (procs *Procs) AdjustOOMPriorityByName(processName string, value int, ignoreIfNonZero bool) error {
	found := false
	pids, err := process.Pids()
	if err != nil {
		return err
	}
	for _, pid := range pids {
		// Find the process with the given name
		if currProcess, err := process.NewProcess(pid); err != nil {
			continue
		} else if name, err := currProcess.Name(); err != nil || name != processName {
			continue
		} else if err := procs.AdjustOOMPriority(int(pid), value, ignoreIfNonZero); err == nil {
			found = true
		} else {
			// Not an error but logging these for debugging.
			log.Printf("Error adjusting OOM for process %s (pid %d): %s", processName, pid, err)
		}
	}
	if found {
		return nil
	}
	return fmt.Errorf("No process matches: %s\n", processName)
}

//AdjustOOMPriority Adjust the OOM adj value for the process with the given pid.
func (procs *Procs) AdjustOOMPriority(pid int, value int, ignoreIfNonZero bool) error {
	valueBytes := []byte(strconv.Itoa(value))
	oomFile := fmt.Sprintf("%s/%d/oom_score_adj", path.Clean(procs.ProcfsPath), pid)
	if currentOOMBytes, err := ioutil.ReadFile(oomFile); err != nil {
		return err
	} else if currentOOMValue, err := parseInt(string(currentOOMBytes)); err != nil {
		return fmt.Errorf("Unable to read OOM adjust for pid: %d\n", pid)
	} else if ignoreIfNonZero && currentOOMValue != 0 {
		return nil
	} else if err = ioutil.WriteFile(oomFile, valueBytes, 0644); err != nil {
		return fmt.Errorf("Unable to OOM adjust for pid: %d\n", pid)
	}
	return nil
}

//AdjustDockerOOMPriority Adjusts the OOM Adj value for the entire docker container specified by the name. This should point to root proc filesystem
func (procs *Procs) AdjustDockerOOMPriority(connection string, containerName string, value int, ignoreIfNonZero bool) error {
	if docker, err := dockerclient.NewDockerClient(connection, nil); err != nil {
		return err
	} else if containers, err := docker.ListContainers(false, false, fmt.Sprintf(`{"name":["^/%s$"]}`, containerName)); err != nil {
		return err
	} else if containerInfo, err := docker.InspectContainer(containers[0].Id); err != nil {
		return err
	} else if err := procs.AdjustOOMPriority(containerInfo.State.Pid, value, ignoreIfNonZero); err != nil {
		return err
	} else {
		return nil
	}
}
