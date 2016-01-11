package psutils

import (
	"fmt"
	"io/ioutil"
	"log"
	"path"
	"strconv"
	"strings"

	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/samalba/dockerclient"
	"resin-supervisor/gosuper/Godeps/_workspace/src/github.com/shirou/gopsutil/process"
)

// Procs - psutils functions associated with the ProcfsPath
type Procs struct {
	ProcfsPath string
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
		} else if name, err := currProcess.Name(); err != nil && name != processName {
			continue
		} else if err := procs.AdjustOOMPriority(int(pid), value, ignoreIfNonZero); err == nil {
			found = true
		} else {
			log.Println(err) // Not an error but logging these for debugging.
		}
	}
	if found {
		return nil
	}
	return fmt.Errorf("No process matches: %s\n", processName)
}

//AdjustOOMPriority Adjust the OOM adj value for the process with the given pid.
func (procs *Procs) AdjustOOMPriority(pid int, value int, ignoreIfNonZero bool) error {
	oomFile := fmt.Sprintf("%s/%d/oom_score_adj", path.Clean(procs.ProcfsPath), pid)
	if currentOOMString, err := ioutil.ReadFile(oomFile); err != nil {
		return err
	} else if currentOOMValue, err := strconv.ParseInt(strings.Replace(string(currentOOMString), "\n", "", -1), 10, 32); err != nil {
		return fmt.Errorf("Unable to read OOM adjust for pid: %d\n", pid)
	} else if ignoreIfNonZero && currentOOMValue != 0 {
		return nil
	} else if err = ioutil.WriteFile(oomFile, []byte(fmt.Sprintf("%d\n", value)), 0644); err != nil {
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
	} else if err = procs.AdjustOOMPriority(containerInfo.State.Pid, value, ignoreIfNonZero); err != nil {
		return err
	} else {
		return nil
	}
}
