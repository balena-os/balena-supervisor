// This package has utilities to deal with the several sources of configuration for the supervisor
package config

import (
	"encoding/json"
	"io/ioutil"
	"log"
	"os"
	"reflect"
	"strconv"

	"resin-supervisor/gosuper/supermodels"
)

// Default location of the UserConfig config.json
const DefaultConfigPath = "/boot/config.json"
const packageJsonPath = "/app/package.json"

// UserConfig: resin's config.json with information about this device
type UserConfig struct {
	ApplicationId string  `json:"applicationId"`
	ApiKey        string  `json:"apikey"`
	UserId        string  `json:"userId"`
	Username      string  `json:"username"`
	DeviceType    string  `json:"deviceType"`
	Uuid          string  `json:"uuid,omitempty"`
	RegisteredAt  float64 `json:"registered_at,omitempty"`
	DeviceId      float64 `json:"deviceId,omitempty"`
}

// Reads a UserConfig structure from path
func ReadConfig(path string) (config UserConfig, err error) {
	if data, err := ioutil.ReadFile(path); err == nil {
		err = json.Unmarshal(data, &config)
	}

	return
}

// Writes a UserConfig structure to a JSON file at path
// TODO: make it atomic
func WriteConfig(userConfig UserConfig, path string) (err error) {
	if data, err := json.Marshal(userConfig); err == nil {
		err = ioutil.WriteFile(path, data, 0666)
	}
	return
}

// Configuration for the supervisor
type SupervisorConfig struct {
	ApiEndpoint      string `config_env:"API_ENDPOINT" config_default:"https://api.resin.io"`
	ListenPort       int    `config_env:"LISTEN_PORT" config_default:"48484"`
	RegistryEndpoint string `config_env:"REGISTRY_ENDPOINT" config_default:"registry.resin.io"`
	Pubnub           struct {
		SubscribeKey string `config_env:"PUBNUB_SUBSCRIBE_KEY" config_default:"sub-c-bananas"`
		PublishKey   string `config_env:"PUBNUB_PUBLISH_KEY" config_default:"pub-c-bananas"`
	}
	MixpanelToken         string `config_env:"MIXPANEL_TOKEN" config_default:"bananasbananas"`
	DockerSocket          string `config_env:"DOCKER_SOCKET" config_default:"/run/docker.sock"`
	HostProc              string `config_env:"HOST_PROC" config_default:"/mnt/root/proc"`
	SupervisorImage       string `config_env:"SUPERVISOR_IMAGE" config_default:"resin/rpi-supervisor"`
	LedFile               string `config_env:"LED_FILE" config_default:"/sys/class/leds/led0/brightness"`
	BootstrapRetryDelay   int    `config_env:"BOOTSTRAP_RETRY_DELAY" config_default:"30000"`
	AppUpdatePollInterval int    `config_env:"APP_UPDATE_POLL_INTERVAL" config_default:"60000"`
	ForceApiSecret        string `config_env:"RESIN_SUPERVISOR_SECRET" config_default:""`
	VpnStatusPath         string `config_env:"VPN_STATUS_PATH" config_default:"/mnt/root/run/openvpn/vpn_status"`
	DatabasePath          string `config_env:"RESIN_SUPERVISOR_DB_PATH" config_default:"/data/resin-supervisor.db"`
}

func populateConfigStruct(value reflect.Value) {
	valueType := value.Type()
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
				if val, err := strconv.Atoi(envValue); err != nil {
					log.Printf("Invalid value for %s: %s", valueType.Field(i).Name, envValue)
				} else {
					f.SetInt(int64(val))
				}
			} else if defaultValue != "" {
				if val, err := strconv.Atoi(defaultValue); err != nil {
					log.Printf("Invalid value for %s: %s", valueType.Field(i).Name, defaultValue)
				} else {
					f.SetInt(int64(val))
				}
			}
		case reflect.Struct:
			populateConfigStruct(f)
		default:
			log.Printf("Unknown config type %s in field %s\n", f.Type(), valueType.Field(i).Name)
		}
	}
}

func populateConfig(v interface{}) {
	value := reflect.ValueOf(v).Elem()
	populateConfigStruct(value)
}

// Gets a SupervisorConfig structure populated according to env vars or default values
func GetSupervisorConfig() (config SupervisorConfig) {
	populateConfig(&config)
	return
}

var supervisorVersion string

// Gets the supervisor version from package.json
// Caches the value so that package.json is only read once
func GetSupervisorVersion() (version string, err error) {
	if supervisorVersion != "" {
		return supervisorVersion, nil
	} else {
		var data []byte
		m := make(map[string]string)
		m["version"] = ""
		if data, err = ioutil.ReadFile(packageJsonPath); err == nil {
			if err = json.Unmarshal(data, &m); err == nil {
				supervisorVersion = m["version"]
			}
		}

		return m["version"], err
	}
}

// Saves some config parameters to the local database (supermodels)
// Saved fields are uuid, apiKey, username, userId, and version (supervisor version)
func SaveToDB(config UserConfig, db *supermodels.Config) (err error) {
	// Save 'uuid', 'apiKey', 'username', 'userId', 'version' to db
	keyvals := make(map[string]string)

	keyvals["uuid"] = config.Uuid
	keyvals["apiKey"] = config.ApiKey
	keyvals["username"] = config.Username
	keyvals["userId"] = config.UserId
	if v, e := GetSupervisorVersion(); e == nil {
		keyvals["version"] = v
	} else {
		log.Printf("Unable to get supervisor version: %s", e)
	}

	if err = db.SetBatch(keyvals); err != nil {
		log.Printf("Unable to save config to database: %s", err)
	}

	return err
}
