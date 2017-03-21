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

//! # API endpoint identifiers
//!
//! The hyper_router module only accepts static funtions as HTTP request
//! handlers. This benefits performance, because the function chaining syntax
//! used by the router requires an ownership transfer, and function pointers
//! can be cheaply copied. However, it means we can't pass a context to the
//! request handler.
//!
//! To solve this, the empty functions below are registered with the router.
//! When a path matches, the router will yield the associated empty function.
//! We use this to identify which handler should be called, and then invoke it
//! with the proper context.
//!
//! Reference:
//!
//! * [Resin Supervisor API](https://github.com/resin-io/resin-supervisor/blob/master/docs/API.md)
//! * [Dependent apps API](https://github.com/resin-io/resin-supervisor/blob/master/docs/dependent-apps.md)

use hyper;

// Documented API
pub fn ping(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn blink(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn update(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn reboot(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn shutdown(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn purge(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn restart(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn enable_tcp_ping(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn disable_tcp_ping(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn regenerate_api_key(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn get_device(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn stop_app(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn start_app(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn get_app(_: hyper::server::Request, _: hyper::server::Response) {}

// Dependent applications API
pub fn get_dependent_apps(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn update_app_registery(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn get_devices(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn provision_device(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn get_device_info(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn update_device_info(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn log(_: hyper::server::Request, _: hyper::server::Response) {}

// Dependent applications API hooks
pub fn notify_restart(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn notify_update(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn notify_delete(_: hyper::server::Request, _: hyper::server::Response) {}

// Node only
pub fn create_image(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn load_image(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn delete_image(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn list_images(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn create_container(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn update_container(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn start_container(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn stop_container(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn delete_container(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn list_containers(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn compose_up(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn compose_down(_: hyper::server::Request, _: hyper::server::Response) {}

// Go only
pub fn id_address(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn vpn_control(_: hyper::server::Request, _: hyper::server::Response) {}
pub fn log_to_display_control(_: hyper::server::Request, _: hyper::server::Response) {}
