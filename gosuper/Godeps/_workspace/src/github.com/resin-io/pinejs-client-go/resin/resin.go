package resin

type Application struct {
	Id            int      `json:"id,omitempty"`
	AppName       string   `json:"app_name"`
	GitRepository string   `json:"git_repository"`
	Commit        string   `json:"commit"`
	Devices       []Device `json:"device"`
}

type Device struct {
	Id                   int          `json:"id,omitempty"`
	Name                 string       `json:"name"`
	DeviceType           string       `json:"device_type"`
	UUID                 string       `json:"uuid"`
	Commit               string       `json:"commit"`
	Note                 string       `json:"note"`
	Status               string       `json:"status"`
	IsOnline             bool         `json:"is_online"`
	LastSeenTime         string       `json:"last_seen_time"`
	IPAddress            string       `json:"ip_address"`
	VPNAddress           string       `json:"vpn_address"`
	OSVersion            string       `json:"os_version"`
	SupervisorVersion    string       `json:"supervisor_version"`
	ProvisioningProgress string       `json:"provisioning_progress"`
	ProvisioningState    string       `json:"provisioning_state"`
	Application          *Application `json:"application"`
	User                 *User        `json:"user"`
}

type EnvironmentVariable struct {
	Id    int    `json:"id,omitempty" pinejs:"environment_variable"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

type User struct {
	Id int `json:"id,omitempty"`
}
