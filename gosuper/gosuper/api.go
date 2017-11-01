package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"resin-supervisor/gosuper/systemd"
)

// APIResponse The api response sent from go supervisor
type APIResponse struct {
	Data  interface{}
	Error string
}

// VPNBody interface for post request received by VPN control end point
type VPNBody struct {
	Enable bool
}

type LogToDisplayBody struct {
	Enable bool
}

func jsonResponse(writer http.ResponseWriter, response interface{}, status int) {
	jsonBody, err := json.Marshal(response)
	if err != nil {
		log.Printf("Could not marshal JSON for %+v\n", response)
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	writer.Write(jsonBody)
}

func parseJSONBody(destination interface{}, request *http.Request) error {
	decoder := json.NewDecoder(request.Body)
	return decoder.Decode(&destination)
}

func responseSenders(writer http.ResponseWriter) (sendResponse func(interface{}, string, int), sendError func(error)) {
	sendResponse = func(data interface{}, errorMsg string, statusCode int) {
		jsonResponse(writer, APIResponse{data, errorMsg}, statusCode)
	}
	sendError = func(err error) {
		sendResponse("Error", err.Error(), http.StatusInternalServerError)
	}
	return
}

func inASecond(theFunc func()) {
	time.Sleep(time.Duration(time.Second))
	theFunc()
}

//RebootHandler Reboots the device using Systemd
func RebootHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Rebooting")

	sendResponse, sendError := responseSenders(writer)
	if systemd.Logind == nil {
		sendError(fmt.Errorf("Logind unavailable, cannot reboot."))
		return
	}
	sendResponse("OK", "", http.StatusAccepted)
	go inASecond(func() { systemd.Logind.Reboot(false) })
}

//ShutdownHandler Shuts down the device using Systemd
func ShutdownHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Shutting down")

	sendResponse, sendError := responseSenders(writer)
	if systemd.Logind == nil {
		sendError(fmt.Errorf("Logind unavailable, cannot shut down."))
		return
	}
	sendResponse("OK", "", http.StatusAccepted)
	go inASecond(func() { systemd.Logind.PowerOff(false) })
}

//VPNControl is used to control VPN service status with dbus
func VPNControl(writer http.ResponseWriter, request *http.Request) {
	sendResponse, sendError := responseSenders(writer)
	var body VPNBody
	if err := parseJSONBody(&body, request); err != nil {
		log.Println(err)
		sendResponse("Error", err.Error(), http.StatusBadRequest)
		return
	}

	if systemd.Dbus == nil {
		sendError(fmt.Errorf("Systemd dbus unavailable, cannot set VPN state."))
		return
	}

	action := systemd.Dbus.StopUnit
	actionDescr := "VPN Disable"
	if body.Enable {
		action = systemd.Dbus.StartUnit
		actionDescr = "VPN Enable"
	}
	if _, err := action("openvpn-resin.service", "fail", nil); err != nil {
		log.Printf("%s: %s\n", actionDescr, err)
		sendError(err)
		return
	}
	log.Printf("%sd\n", actionDescr)
	sendResponse("OK", "", http.StatusAccepted)
}

func getUnitStatus(unitName string) (state bool, err error) {
	if systemd.Dbus == nil {
		err = fmt.Errorf("Systemd dbus unavailable, cannot get unit status.")
		return
	}
	if activeState, e := systemd.Dbus.GetUnitProperty(unitName, "ActiveState"); e != nil {
		err = fmt.Errorf("Unable to get unit status: %v", e)
		return
	} else {
		state = activeState.Value.String() == `"active"`
		return
	}
}

func unitStatusHandler(serviceName string, writer http.ResponseWriter, request *http.Request) {
	sendResponse, sendError := responseSenders(writer)
	if status, err := getUnitStatus(serviceName); err != nil {
		sendError(fmt.Errorf("Unable to get VPN status: %v", err))
		return
	} else {
		sendResponse(status, "", http.StatusOK)
	}
}

func VPNStatus(writer http.ResponseWriter, request *http.Request) {
	unitStatusHandler("openvpn-resin.service", writer, request)
}

func logToDisplayServiceName() (serviceName string, err error) {
	serviceName = "resin-info@tty1.service"
	serviceNameOld := "tty-replacement.service"
	if systemd.Dbus == nil {
		err = fmt.Errorf("Systemd dbus unavailable, cannot get log to display service.")
		return
	}
	if loaded, e := systemd.Dbus.GetUnitProperty(serviceName, "LoadState"); e != nil {
		err = fmt.Errorf("Unable to get log to display load status: %v", e)
		return
	} else if loaded.Value.String() == `"not-found"` {
		// If the resin-info service is not found, we're on an older OS
		// which uses a different service name
		serviceName = serviceNameOld
	}
	if loaded, e := systemd.Dbus.GetUnitProperty(serviceName, "LoadState"); e != nil {
		err = fmt.Errorf("Unable to get log to display load status: %v", e)
		return
	} else if loaded.Value.String() == `"not-found"` {
		// We might be in a different OS that just doesn't have the service
		serviceName = ""
		return
	}
	return
}

func LogToDisplayStatus(writer http.ResponseWriter, request *http.Request) {
	sendResponse, sendError := responseSenders(writer)
	serviceName, err := logToDisplayServiceName()
	if err != nil {
		sendError(err)
		return
	} else if serviceName == "" {
		sendResponse("Error", "Not found", http.StatusNotFound)
		return
	}
	unitStatusHandler(serviceName, writer, request)
}

//LogToDisplayControl is used to control tty-replacement service status with dbus
func LogToDisplayControl(writer http.ResponseWriter, request *http.Request) {
	sendResponse, sendError := responseSenders(writer)
	var body LogToDisplayBody
	if err := parseJSONBody(&body, request); err != nil {
		log.Println(err)
		sendResponse("Error", err.Error(), http.StatusBadRequest)
		return
	}

	if systemd.Dbus == nil {
		sendError(fmt.Errorf("Systemd dbus unavailable, cannot set log to display state."))
		return
	}

	serviceName, err := logToDisplayServiceName()
	if err != nil {
		sendError(err)
		return
	} else if serviceName == "" {
		sendResponse("Error", "Not found", http.StatusNotFound)
		return
	}

	if status, err := getUnitStatus(serviceName); err != nil {
		sendError(fmt.Errorf("Unable to get log to display status: %v", err))
		return
	} else {
		enable := body.Enable
		if status == enable {
			// Nothing to do, return Data = false to signal nothing was changed
			sendResponse(false, "", http.StatusOK)
			return
		} else if enable {
			if _, err := systemd.Dbus.StartUnit(serviceName, "fail", nil); err != nil {
				sendError(fmt.Errorf("Unable to start service: %v", err))
				return
			}
			if _, _, err = systemd.Dbus.EnableUnitFiles([]string{serviceName}, false, false); err != nil {
				sendError(fmt.Errorf("Unable to enable service: %v", err))
				return
			}
		} else {
			if _, err := systemd.Dbus.StopUnit(serviceName, "fail", nil); err != nil {
				sendError(fmt.Errorf("Unable to stop service: %v", err))
				return
			}
			if _, err = systemd.Dbus.DisableUnitFiles([]string{serviceName}, false); err != nil {
				sendError(fmt.Errorf("Unable to disable service: %v", err))
				return
			}
		}
		sendResponse(true, "", http.StatusOK)
	}
}
