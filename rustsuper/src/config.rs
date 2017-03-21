//
//      Copyright 2017 Resin.io
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.
//

use rustc_serialize;
use std;
use std::io::Read;

/// The path to the user's config.json file
const CONFIG_FILE: &'static str = "tests/config_for_test.json"; // TODO

/// Environment variables read at runtime
const ENV_VAR_LISTEN_ADDRESS: &'static str = "GOSUPER_SOCKET";
const ENV_VAR_DOCKER_SOCKET: &'static str = "DOCKER_SOCKET";
const ENV_VAR_HOST_PROC: &'static str = "HOST_PROC";
const ENV_VAR_DBUS_SYSTEM_BUS_ADDRESS: &'static str = "DBUS_SYSTEM_BUS_ADDRESS";
const ENV_VAR_RESIN_DATA_PATH: &'static str = "RESIN_DATA_PATH";

#[derive(RustcDecodable, Debug, Clone)]
#[allow(non_snake_case)]
struct UserConfigJson {
    applicationId: String,
    apiKey: String,
    userId: String,
    username: String,
    deviceType: String,
    uuid: String,
    registered_at: f64,
    deviceId: f64,
}

#[derive(RustcDecodable, Debug, Clone)]
struct EnvConfig {
    listen_address: String,
    docker_socket: String,
    host_proc: String,
    dbus_system_bus_address: String,
    resin_data_path: String,
}

/// Load a config.json file
///
/// # Arguments
///
/// * `filename` - The path to the config.json file
///
/// Returns a result containing the json contents of the file as a string, or
/// an IO error if it failed to read config.json.
fn load_user_config(filename: &str) -> Result<String, std::io::Error> {
    match std::fs::File::open(filename) {
        Ok(mut file) => {
            let mut data = String::new();
            match file.read_to_string(&mut data) {
                Ok(_) => Ok(data),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

/// Parse the JSON content of a config.json file
///
/// # Arguments
///
/// * `data` - The JSON string
///
/// Returns a struct of the parsed JSON data, or a JSON decoding error on\
/// failure.
fn parse_user_config(data: &str) -> Result<UserConfigJson, rustc_serialize::json::DecoderError> {
    rustc_serialize::json::decode(data)
}

/// Load configuration properties from environment variables
///
/// Returns a struct of the environment properties, or the name of a missing
/// environment variable.
fn load_env_config() -> Result<EnvConfig, &'static str> {
    let listen_address: String;
    let docker_socket: String;
    let host_proc: String;
    let dbus_system_bus_address: String;
    let resin_data_path: String;

    match std::env::var(ENV_VAR_LISTEN_ADDRESS) {
        Ok(value) => listen_address = value,
        Err(_) => return Err(ENV_VAR_LISTEN_ADDRESS),
    }

    match std::env::var(ENV_VAR_DOCKER_SOCKET) {
        Ok(value) => docker_socket = value,
        Err(_) => return Err(ENV_VAR_DOCKER_SOCKET),
    }

    match std::env::var(ENV_VAR_HOST_PROC) {
        Ok(value) => host_proc = value,
        Err(_) => return Err(ENV_VAR_HOST_PROC),
    }

    match std::env::var(ENV_VAR_DBUS_SYSTEM_BUS_ADDRESS) {
        Ok(value) => dbus_system_bus_address = value,
        Err(_) => return Err(ENV_VAR_DBUS_SYSTEM_BUS_ADDRESS),
    }

    match std::env::var(ENV_VAR_RESIN_DATA_PATH) {
        Ok(value) => resin_data_path = value,
        Err(_) => return Err(ENV_VAR_RESIN_DATA_PATH),
    }

    debug!("{} = {}", ENV_VAR_LISTEN_ADDRESS, listen_address);
    debug!("{} = {}", ENV_VAR_DOCKER_SOCKET, docker_socket);
    debug!("{} = {}", ENV_VAR_HOST_PROC, host_proc);
    debug!("{} = {}",
           ENV_VAR_DBUS_SYSTEM_BUS_ADDRESS,
           dbus_system_bus_address);
    debug!("{} = {}", ENV_VAR_RESIN_DATA_PATH, resin_data_path);

    Ok(EnvConfig {
           listen_address: listen_address,
           docker_socket: docker_socket,
           host_proc: host_proc,
           dbus_system_bus_address: dbus_system_bus_address,
           resin_data_path: resin_data_path,
       })
}

/// Represents the configuration for the supervisor
///
/// This class provides public accessor methods to abstract the origin of the
/// settings. The user is therefore unconcerned if a configuration property
/// comes from config.json or an environment variable. Additionally, this
/// masks the name of the JSON key using snake_case.
#[derive(Clone)]
pub struct Config {
    user: UserConfigJson,
    env: EnvConfig,
}

impl Config {
    /// Returns a loaded configuration, or None if an error occurs
    pub fn load() -> Option<Config> {
        info!("Loading configuration file: {}", CONFIG_FILE);

        let json = load_user_config(CONFIG_FILE);
        if !json.is_ok() {
            error!("Failed to load configuration file: {}", json.unwrap_err());
            return None;
        }

        let user_config = parse_user_config(&json.unwrap());
        if !user_config.is_ok() {
            error!("Failed to parse configuration file: {}",
                   user_config.unwrap_err());
            return None;
        }

        info!("Successfully loaded configuration file");

        let env_config = load_env_config();
        if !env_config.is_ok() {
            error!("Failed to read environment variable: {}",
                   env_config.unwrap_err());
            return None;
        }

        Some(Config {
                 user: user_config.unwrap(),
                 env: env_config.unwrap(),
             })
    }

    pub fn application_id(&self) -> &String {
        &self.user.applicationId
    }

    pub fn api_key(&self) -> &String {
        &self.user.apiKey
    }

    pub fn user_id(&self) -> &String {
        &self.user.userId
    }

    pub fn username(&self) -> &String {
        &self.user.userId
    }

    pub fn device_type(&self) -> &String {
        &self.user.deviceType
    }

    pub fn uuid(&self) -> &String {
        &self.user.uuid
    }

    pub fn registered_at(&self) -> f64 {
        self.user.registered_at
    }

    pub fn device_id(&self) -> f64 {
        self.user.deviceId
    }

    pub fn listen_address(&self) -> &String {
        &self.env.listen_address
    }

    pub fn docker_socket(&self) -> &String {
        &self.env.docker_socket
    }

    pub fn host_proc(&self) -> &String {
        &self.env.host_proc
    }

    pub fn dbus_system_bus_address(&self) -> &String {
        &self.env.dbus_system_bus_address
    }

    pub fn resin_data_path(&self) -> &String {
        &self.env.resin_data_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_CONFIG_FILE: &'static str = "tests/config_for_test.json";

    const CONFIG_JSON: &'static str = concat!(
r#"{"applicationId":"1939","apiKey":"SuperSecretAPIKey","userId":"141","usern"#,
r#"ame":"gh_pcarranzav","deviceType":"raspberry-pi2","files":{"network/settin"#,
r#"gs":"[global]\nOfflineMode=false\n\n[WiFi]\nEnable=true\nTethering=false\n"#,
r#"\n[Wired]\nEnable=true\nTethering=false\n\n[Bluetooth]\nEnable=true\nTethe"#,
r#"ring=false","network/network.config":"[service_home_ethernet]\nType = ethe"#,
r#"rnet\nNameservers = 8.8.8.8,8.8.4.4"},"uuid":"07cf830a18757a78e69293ef2daf"#,
r#"315506074a59f694555c124f0151e67f8d","registered_at":1436987572906,"deviceI"#,
r#"d":24748}"#);

    #[test]
    fn unit_test_read_config() {
        let json = load_user_config(TEST_CONFIG_FILE);
        assert!(json.is_ok());
        assert_eq!(CONFIG_JSON, json.unwrap());
    }

    #[test]
    fn unit_test_parse_json() {
        let config = parse_user_config(CONFIG_JSON);
        assert!(config.is_ok());
    }

    const TEST_LISTEN_ADDRESS: &'static str = "/var/run/resin/gosuper.sock";
    const TEST_DOCKER_SOCKET: &'static str = "/run/docker.sock";
    const TEST_HOST_PROC: &'static str = "/mnt/root/proc";
    const TEST_DBUS_SYSTEM_BUS_ADDRESS: &'static str = "unix:path=/mnt/root/run/dbus/system_bus_socket";
    const TEST_RESIN_DATA_PATH: &'static str = "/resin-data";

    #[test]
    fn unit_test_load_env() {
        std::env::set_var(ENV_VAR_LISTEN_ADDRESS, TEST_LISTEN_ADDRESS);
        std::env::set_var(ENV_VAR_DOCKER_SOCKET, TEST_DOCKER_SOCKET);
        std::env::set_var(ENV_VAR_HOST_PROC, TEST_HOST_PROC);
        std::env::set_var(ENV_VAR_DBUS_SYSTEM_BUS_ADDRESS,
                          TEST_DBUS_SYSTEM_BUS_ADDRESS);
        std::env::set_var(ENV_VAR_RESIN_DATA_PATH, TEST_RESIN_DATA_PATH);

        let config = load_env_config();
        assert!(config.is_ok());
        let config = config.unwrap();
        assert_eq!(TEST_LISTEN_ADDRESS, config.listen_address);
        assert_eq!(TEST_DOCKER_SOCKET, config.docker_socket);
        assert_eq!(TEST_HOST_PROC, config.host_proc);
        assert_eq!(TEST_DBUS_SYSTEM_BUS_ADDRESS, config.dbus_system_bus_address);
        assert_eq!(TEST_RESIN_DATA_PATH, config.resin_data_path);
    }
}
