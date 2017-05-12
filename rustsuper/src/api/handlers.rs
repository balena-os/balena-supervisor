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

//! API handlers

use api::API;
use api::params::*;
use api::utils::*;

use hyper;
use regex;

/// Errors returned to API calls
pub enum APIError {
    Locked,
    FailedWithError(String),
    Failed,
}

/// Interface for handling API calls
pub trait EndpointHandler {
    fn handle(&self, &API, hyper::server::Request, hyper::server::Response);
}

pub struct Ping;
pub struct Blink;
pub struct Update;
pub struct Reboot;
pub struct Shutdown;
pub struct Purge;
pub struct Restart;
pub struct EnableTcpPing;
pub struct DisableTcpPing;
pub struct RegenerateApiKey;
pub struct GetDevice;
pub struct StopApp;
pub struct StartApp;
pub struct GetApp;
pub struct GetDependentApps;
pub struct UpdateAppRegistry;
pub struct GetDevices;
pub struct ProvisionDevice;
pub struct GetDeviceInfo;
pub struct UpdateDeviceInfo;
pub struct Log;
pub struct CreateImage;
pub struct LoadImage;
pub struct DeleteImage;
pub struct ListImgages;
pub struct CreateContainer;
pub struct UpdateContainer;
pub struct StartContainer;
pub struct StopContainer;
pub struct DeleteContainer;
pub struct ListContainers;
pub struct ComposeUp;
pub struct ComposeDown;
pub struct IpAddress;
pub struct VpnControl;
pub struct LogToDisplayControl;

impl EndpointHandler for Ping {
    fn handle(&self, _: &API, _: hyper::server::Request, response: hyper::server::Response) {
        response.send(b"OK").unwrap();
    }
}

impl EndpointHandler for Blink {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.device.blink() {
            Ok(_) => {
                *response.status_mut() = hyper::status::StatusCode::Ok;
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for Update {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<UpdateParams>(&mut request, &mut response) {
            Ok(params) => {
                match api.application.update(params.force) {
                    Ok(_) => {
                        *response.status_mut() = hyper::status::StatusCode::NoContent;
                    }
                    Err(error) => {
                        handle_error(error, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}

impl EndpointHandler for Reboot {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<RebootParams>(&mut request, &mut response) {
            Ok(params) => {
                match api.device.reboot(params.force) {
                    Ok(_) => {
                        *response.status_mut() = hyper::status::StatusCode::NoContent;
                        let result = RebootResponse {
                            Data: "OK".to_string(),
                            Error: "".to_string(),
                        };
                        send_response(result, response);
                    }
                    Err(error) => {
                        handle_error(error, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}

impl EndpointHandler for Shutdown {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<RebootParams>(&mut request, &mut response) {
            Ok(params) => {
                match api.device.shutdown(params.force) {
                    Ok(_) => {
                        *response.status_mut() = hyper::status::StatusCode::NoContent;
                        let result = ShutdownResponse {
                            Data: "OK".to_string(),
                            Error: "".to_string(),
                        };
                        send_response(result, response);
                    }
                    Err(error) => {
                        handle_error(error, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}

impl EndpointHandler for Purge {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.application.purge() {
            Ok(_) => {
                *response.status_mut() = hyper::status::StatusCode::Ok;
                let result = PurgeResponse {
                    Data: "OK".to_string(),
                    Error: "".to_string(),
                };
                send_response(result, response);
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for Restart {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<RestartParams>(&mut request, &mut response) {
            Ok(params) => {
                match api.application.restart(params.appId, params.force) {
                    Ok(_) => {
                        *response.status_mut() = hyper::status::StatusCode::NoContent;
                        response.send(b"OK").unwrap();
                    }
                    Err(error) => {
                        handle_error(error, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}

impl EndpointHandler for EnableTcpPing {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.network.enable_check() {
            Ok(_) => {
                *response.status_mut() = hyper::status::StatusCode::NoContent;
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for DisableTcpPing {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.network.disable_check() {
            Ok(_) => {
                *response.status_mut() = hyper::status::StatusCode::NoContent;
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for RegenerateApiKey {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.application.regenerate_api_key() {
            Ok(_) => {
                *response.status_mut() = hyper::status::StatusCode::Ok;
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for GetDevice {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.device.get_device() {
            Ok(device_info) => {
                *response.status_mut() = hyper::status::StatusCode::Ok;
                let result = GetDeviceResponse {
                    api_port: device_info.api_port,
                    commit: device_info.commit,
                    ip_address: device_info.ip_address,
                    status: device_info.status,
                    download_progress: device_info.download_progress,
                    os_version: device_info.os_version,
                    supervisor_version: device_info.supervisor_version,
                    update_pending: device_info.update_pending,
                    update_downloaded: device_info.update_downloaded,
                    update_failed: device_info.update_failed,
                };
                send_response(result, response);
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for StopApp {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<StopAppParams>(&mut request, &mut response) {
            Ok(params) => {
                match request.uri {
                    hyper::uri::RequestUri::AbsolutePath(path) => {
                        let re = regex::Regex::new(r"/v1/apps/(\d+)/stop").unwrap();
                        let cap = re.captures(&path).unwrap();
                        match cap.get(1) {
                            Some(app_id) => {
                                match api.application.stop_app(app_id.as_str()
                                                                   .parse::<u64>()
                                                                   .unwrap(),
                                                               params.force) {
                                    Ok(container_id) => {
                                        *response.status_mut() = hyper::status::StatusCode::Ok;
                                        let result = StopAppResponse { containerId: container_id };
                                        send_response(result, response);
                                    }
                                    Err(error) => {
                                        handle_error(error, response);
                                    }
                                }
                            }
                            None => {
                                handle_error(APIError::Failed, response);
                            }
                        }
                    }
                    _ => {
                        handle_error(APIError::Failed, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}

impl EndpointHandler for StartApp {
    fn handle(&self,
              api: &API,
              request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match request.uri {
            hyper::uri::RequestUri::AbsolutePath(path) => {
                let re = regex::Regex::new(r"/v1/apps/(\d+)/start").unwrap();
                let cap = re.captures(&path).unwrap();
                match cap.get(1) {
                    Some(app_id) => {
                        match api.application.start_app(app_id.as_str().parse::<u64>().unwrap()) {
                            Ok(container_id) => {
                                *response.status_mut() = hyper::status::StatusCode::Ok;
                                let result = StartAppResponse { containerId: container_id };
                                send_response(result, response);
                            }
                            Err(error) => {
                                handle_error(error, response);
                            }
                        }
                    }
                    None => {
                        handle_error(APIError::Failed, response);
                    }
                }
            }
            _ => {
                handle_error(APIError::Failed, response);
            }
        }
    }
}

impl EndpointHandler for GetApp {
    fn handle(&self,
              api: &API,
              request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match request.uri {
            hyper::uri::RequestUri::AbsolutePath(path) => {
                let re = regex::Regex::new(r"/v1/apps/(\d+)").unwrap();
                let cap = re.captures(&path).unwrap();
                match cap.get(1) {
                    Some(app_id) => {
                        match api.application.get_app(app_id.as_str().parse::<u64>().unwrap()) {
                            Ok(app_info) => {
                                *response.status_mut() = hyper::status::StatusCode::Ok;
                                let result = GetAppResponse {
                                    appId: app_info.app_id,
                                    commit: app_info.commit,
                                    imageId: app_info.image_id,
                                    containerId: app_info.container_id, // TODO: env
                                };
                                send_response(result, response);
                            }
                            Err(error) => {
                                handle_error(error, response);
                            }
                        }
                    }
                    None => {
                        handle_error(APIError::Failed, response);
                    }
                }
            }
            _ => {
                handle_error(APIError::Failed, response);
            }
        }
    }
}

impl EndpointHandler for GetDependentApps {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for UpdateAppRegistry {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for GetDevices {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for ProvisionDevice {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for GetDeviceInfo {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for UpdateDeviceInfo {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for Log {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for CreateImage {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for LoadImage {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for DeleteImage {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for ListImgages {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for CreateContainer {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for UpdateContainer {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for StartContainer {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for StopContainer {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for DeleteContainer {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for ListContainers {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for ComposeUp {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for ComposeDown {
    fn handle(&self, _: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        // TODO
        *response.status_mut() = hyper::status::StatusCode::NotImplemented;
    }
}

impl EndpointHandler for IpAddress {
    fn handle(&self, api: &API, _: hyper::server::Request, mut response: hyper::server::Response) {
        match api.network.get_ip_addresses() {
            Ok(_) => {
                *response.status_mut() = hyper::status::StatusCode::Ok;
                let result = IpAddressResponse {
                    Data: "OK".to_string(), // TODO
                    Error: "".to_string(),
                };
                send_response(result, response);
            }
            Err(error) => {
                handle_error(error, response);
            }
        }
    }
}

impl EndpointHandler for VpnControl {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<VpnControlParams>(&mut request, &mut response) {
            Ok(params) => {
                match api.network.vpn_control(params.Enable) {
                    Ok(_) => {
                        *response.status_mut() = hyper::status::StatusCode::Ok;
                        let result = VpnControlResponse {
                            Data: "OK".to_string(),
                            Error: "".to_string(),
                        };
                        send_response(result, response);
                    }
                    Err(error) => {
                        handle_error(error, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}

impl EndpointHandler for LogToDisplayControl {
    fn handle(&self,
              api: &API,
              mut request: hyper::server::Request,
              mut response: hyper::server::Response) {
        match get_params::<LogToDisplayControlParams>(&mut request, &mut response) {
            Ok(params) => {
                match api.device.log_to_display_control(params.Enable) {
                    Ok(_) => {
                        *response.status_mut() = hyper::status::StatusCode::Ok;
                        let result = LogToDisplayControlResponse {
                            Data: "OK".to_string(),
                            Error: "".to_string(),
                        };
                        send_response(result, response);
                    }
                    Err(error) => {
                        handle_error(error, response);
                    }
                }
            }
            Err(error_body) => {
                response.send(error_body.as_bytes()).unwrap();
            }
        }
    }
}
