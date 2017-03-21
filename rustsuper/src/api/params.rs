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

//! # Parameters for API calls
//!
//! Parameters are passed through the URL and the request body. The request
//! body is JSON. We define the JSON parameters here so that Rust can generate
//! the deserialization boilerplate.
//!
//! Documentation:
//!
//! * [Resin Supervisor API](https://github.com/resin-io/resin-supervisor/blob/master/docs/API.md)
//! * [Dependent apps API](https://github.com/resin-io/resin-supervisor/blob/master/docs/dependent-apps.md)

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct UpdateParams {
    pub force: bool,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct RebootParams {
    pub force: bool,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct RebootResponse {
    pub Data: String,
    pub Error: String,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct ShutdownParams {
    pub force: bool,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct ShutdownResponse {
    pub Data: String,
    pub Error: String,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct PurgeParams {
    pub appId: u64,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct PurgeResponse {
    pub Data: String,
    pub Error: String,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct RestartParams {
    pub appId: u64,
    pub force: bool,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct GetDeviceResponse {
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

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct StopAppParams {
    pub force: bool,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct StopAppResponse {
    pub containerId: String,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct StartAppResponse {
    pub containerId: String,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct GetAppResponse {
    pub appId: u64,
    pub commit: String,
    pub imageId: String,
    pub containerId: String, // TODO: env
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct ProvisionDeviceParams {
    pub appId: u64,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct UpdateDeviceInfoParams {
    pub is_online: bool,
    pub status: String,
    pub commit: String,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct LogParams {
    pub message: String,
    pub timestamp: u64,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct IpAddressResponse {
    pub Data: String,
    pub Error: String,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct VpnControlParams {
    pub Enable: bool,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct VpnControlResponse {
    pub Data: String,
    pub Error: String,
}

#[derive(RustcDecodable)]
#[allow(non_snake_case)]
pub struct LogToDisplayControlParams {
    pub Enable: bool,
}

#[derive(RustcEncodable)]
#[allow(non_snake_case)]
pub struct LogToDisplayControlResponse {
    pub Data: String,
    pub Error: String,
}
