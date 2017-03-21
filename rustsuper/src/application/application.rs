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

/// Struct representing info about an application
pub struct AppInfo {
    pub app_id: u64,
    pub commit: String,
    pub image_id: String,
    pub container_id: String, // TODO: env
}

/// Application operations
pub struct Application {
    config: Config,
}

impl Application {
    pub fn new(config: Config) -> Application {
        Application { config: config }
    }

    pub fn update(&self, force: bool) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn purge(&self) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn restart(&self, app_id: u64, force: bool) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn regenerate_api_key(&self) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn stop_app(&self, app_id: u64, force: bool) -> Result<String, APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn start_app(&self, app_id: u64) -> Result<String, APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn get_app(&self, app_id: u64) -> Result<AppInfo, APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }
}
