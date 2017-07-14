package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"resin-supervisor/gosuper/systemd"
)

// Compile the expression once, usually at init time.
// Use raw strings to avoid having to quote the backslashes.
var dockerMatch = regexp.MustCompile(`(docker[0-9]+)|(rce[0-9]+)|(tun[0-9]+)|(resin-vpn)`)

// APIResponse The api response sent from go supervisor
type APIResponse struct {
	Data  interface{}
	Error string
}

//PurgeBody struct for the ApplicationId interfact
type PurgeBody struct {
	ApplicationId interface{}
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

func parsePurgeBody(request *http.Request) (appId string, err error) {
	var body PurgeBody
	if err = parseJSONBody(&body, request); err != nil {
		return
	}
	switch v := body.ApplicationId.(type) {
	case string:
		appId = v
	case float64:
		if v != 0 {
			appId = strconv.Itoa(int(v))
		}
	default:
		log.Printf("Invalid appId type %T\n", v)
	}
	return
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

// PurgeHandler Purges the data of the appID's application in the /data partition
func PurgeHandler(writer http.ResponseWriter, request *http.Request) {
	log.Println("Purging /data")
	sendResponse, sendError := responseSenders(writer)
	sendBadRequest := func(errorMsg string) {
		sendResponse("Error", errorMsg, http.StatusBadRequest)
	}

	if appId, err := parsePurgeBody(request); err != nil {
		sendBadRequest("Invalid request")
	} else if appId == "" {
		sendBadRequest("applicationId is required")
	} else if !IsValidAppId(appId) {
		sendBadRequest(fmt.Sprintf("Invalid applicationId '%s'", appId))
	} else if _, err = os.Stat(ResinDataPath + appId); err != nil {
		if os.IsNotExist(err) {
			sendResponse("Error", fmt.Sprintf("Invalid applicationId '%s': Directory does not exist", appId), http.StatusNotFound)
		} else {
			sendError(err)
		}
	} else if err = os.RemoveAll(ResinDataPath + appId); err != nil {
		sendError(err)
	} else if err = os.Mkdir(ResinDataPath+appId, 0755); err != nil {
		sendError(err)
	} else {
		sendResponse("OK", "", http.StatusOK)
	}
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

// This function returns all active IPs of the interfaces that arent docker/rce and loopback
func ipAddress() (ipAddresses []string, err error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ipAddresses, err
	}
	for _, iface := range ifaces {
		if (iface.Flags&net.FlagUp == 0) || (iface.Flags&net.FlagLoopback != 0) || dockerMatch.MatchString(iface.Name) {
			continue // Interface down or Interface is loopback or Interface is a docker IP
		}
		addrs, err := iface.Addrs()
		if err != nil {
			return ipAddresses, err
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			default:
				log.Printf("Warning: Unrecognised type %T\n", v)
				continue
			}
			if ip == nil {
				continue
			}
			if ip = ip.To4(); ip == nil {
				continue // This isnt an IPv4 Addresss
			}
			ipAddresses = append(ipAddresses, ip.String())
		}
	}
	return
}

//IPAddressHandler is used to reply back with an array of the IPaddress used by the system.
func IPAddressHandler(writer http.ResponseWriter, request *http.Request) {
	sendResponse, sendError := responseSenders(writer)
	if ipAddr, err := ipAddress(); err != nil {
		sendError(err)
	} else {
		payload := make(map[string][]string)
		payload["IPAddresses"] = ipAddr
		sendResponse(payload, "", http.StatusOK)
	}
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
	if status, err := GetUnitState(serviceName); err != nil {
		sendError(fmt.Errorf("Unable to get VPN status: %v", err))
		return
	} else {
		sendResponse(state, "", http.StatusOK)
	}
}

func VPNStatus(writer http.ResponseWriter, request *http.Request) {
	unitStatusHandler("openvpn-resin.service", writer, request)
}

func logToDisplayServiceName() (serviceName string, err error) {
	serviceName = "resin-info@tty1.service"
	serviceNameOld := "tty-replacement.service"
	if systemd.Dbus == nil {
		sendError(fmt.Errorf("Systemd dbus unavailable, cannot get log to display service."))
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
	return
}

func LogToDisplayStatus(writer http.ResponseWriter, request *http.Request) {
	_, sendError := responseSenders(writer)
	serviceName, err := logToDisplayServiceName()
	if err != nil {
		sendError(err)
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
