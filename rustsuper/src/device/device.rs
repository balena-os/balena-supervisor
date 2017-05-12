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

use api::APIError;
use config::Config;

/// Represents info about the device
pub struct DeviceInfo {
    pub api_port: u16,
    pub commit: String,
    pub ip_address: String,
    pub status: String,
    pub download_progress: u8,
    pub os_version: String,
    pub supervisor_version: String,
    pub update_pending: bool,
    pub update_downloaded: bool,
    pub update_failed: bool,
}

/// Device operations
pub struct Device {
    config: Config,
}

impl Device {
    pub fn new(config: Config) -> Device {
        Device { config: config }
    }

    pub fn blink(&self) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn reboot(&self, force: bool) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn shutdown(&self, force: bool) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn get_device(&self) -> Result<DeviceInfo, APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn log_to_display_control(&self, enable: bool) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }
}
