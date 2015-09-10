package main

import (
	"encoding/json"
	"io/ioutil"
	"reflect"
	"strconv"
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

func populateConfigStruct(value reflect.Value) {
	valueType = value.Type()
	for i := 0; i < value.NumField(); i++ {
		f := value.Field(i)
		envValue := os.Getenv(valueType.Field(i).Tag.Get("config_env"))
		defaultValue := valueType.Field(i).Tag.Get("config_default")
		switch f.Kind() {
		case reflect.String:
			if envValue != "" {
				f.SetString(envValue)
			} else if defaultValue != "" {
				f.SetString(defaultValue)
			}
		case reflect.Int:
			if envValue != "" {
				f.SetInt(strconv.Atoi(envValue))
			} else if defaultValue != "" {
				f.SetInt(strconv.Atoi(defaultValue))
			}
		case reflect.Struct:
			populate(f, f.Type)
		default:
			log.Printf("Unknown config type %s in field %s\n", f.Type(), valueType.Field(i).Name)
		}
	}
}

func populateConfig(v interface{}) {
	value = reflect.ValueOf(v).Elem()
	populateConfigStruct(value)
}

func GetSupervisorConfig() (config SupervisorConfig) {
	populateConfig(&config)
	return
}
