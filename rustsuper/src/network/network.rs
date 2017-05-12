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

/// Network operations
pub struct Network {
    config: Config,
}

impl Network {
    pub fn new(config: Config) -> Network {
        Network { config: config }
    }

    pub fn enable_check(&self) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn disable_check(&self) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn get_ip_addresses(&self) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }

    pub fn vpn_control(&self, enable: bool) -> Result<(), APIError> {
        // TODO
        Err(APIError::FailedWithError("Not implemented".to_string()))
    }
}
