package main

import (
	"encoding/json"
	"io/ioutil"
	"reflect"
)

type UserConfig struct {
	ApplicationId string
	ApiKey        string
	UserId        string
	Username      string
	DeviceType    string
	Uuid          string
	RegisteredAt  float64
	DeviceId      float64
}

func ReadConfig(path string) (config UserConfig, err error) {
	if data, err := ioutil.ReadFile(path); err == nil {
		err = json.Unmarshal(data, &config)
	}

	return
}

type SupervisorConfig struct {
	ApiEndpoint      string `config_env:"API_ENDPOINT",config_default:"https://api.resin.io"`
	ListenPort       int    `config_env:"LISTEN_PORT",config_default:"48484"`
	RegistryEndpoint string `config_env:"REGISTRY_ENDPOINT",config_default:"registry.resin.io"`
	Pubnub           struct {
		SubscribeKey string `config_env:"PUBNUB_SUBSCRIBE_KEY",config_default:"sub-c-bananas"`
		PublishKey   string `config_env:"PUBNUB_PUBLISH_KEY",config_default:"pub-c-bananas"`
	}
	MixpanelToken         string `config_env:"MIXPANEL_TOKEN",config_default:"bananasbananas"`
	DockerSocket          string `config_env:"DOCKER_SOCKET",config_default:"/run/docker.sock"`
	SupervisorImage       string `config_env:"SUPERVISOR_IMAGE",config_default:"resin/rpi-supervisor"`
	LedFile               string `config_env:"LED_FILE",config_default:"/sys/class/leds/led0/brightness"`
	BootstrapRetryDelay   int    `config_env:"LED_FILE",config_default:"30000"`
	AppUpdatePollInterval int    `config_env:"LED_FILE",config_default:"60000"`
	ForceApiSecret        string `config_env:"RESIN_SUPERVISOR_SECRET",config_default:""`
	VpnStatusPath         string `config_env:"VPN_STATUS_PATH",config_default:"/mnt/root/run/openvpn/vpn_status"`
}

func GetSupervisorConfig() (config SupervisorConfig) {
	config.ApiEndpoint = os.Getenv("GOSUPER_SOCKET")
	/*
		apiEndpoint: process.env.API_ENDPOINT ? 'https://api.resin.io'
		listenPort: process.env.LISTEN_PORT ? 80
		gosuperAddress: "http://unix:#{process.env.GOSUPER_SOCKET}:"
		registryEndpoint: process.env.REGISTRY_ENDPOINT ? 'registry.resin.io'
		pubnub:
			subscribe_key: process.env.PUBNUB_SUBSCRIBE_KEY ? 'sub-c-bananas'
			publish_key: process.env.PUBNUB_PUBLISH_KEY ? 'pub-c-bananas'
		mixpanelToken: process.env.MIXPANEL_TOKEN ? 'bananasbananas'
		dockerSocket: process.env.DOCKER_SOCKET ? '/run/docker.sock'
		supervisorImage: process.env.SUPERVISOR_IMAGE ? 'resin/rpi-supervisor'
		configMountPoint: process.env.CONFIG_MOUNT_POINT ? '/mnt/mmcblk0p1/config.json'
		ledFile: process.env.LED_FILE ? '/sys/class/leds/led0/brightness'
		bootstrapRetryDelay: checkInt(process.env.BOOTSTRAP_RETRY_DELAY_MS) ? 30000
		restartSuccessTimeout: checkInt(process.env.RESTART_SUCCESS_TIMEOUT) ? 60000
		appUpdatePollInterval: checkInt(process.env.APPLICATION_UPDATE_POLL_INTERVAL) ? 60000
		successMessage: 'SUPERVISOR OK'
		forceApiSecret: process.env.RESIN_SUPERVISOR_SECRET ? null
		vpnStatusPath: process.env.VPN_STATUS_PATH ? '/mnt/root/run/openvpn/vpn_status'
	*/
}
