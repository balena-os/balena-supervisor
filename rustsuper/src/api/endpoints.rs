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

use api::handlers::*;
use api::ids::*;
use api::utils::*;

use hyper_router;

/// Tuple containing info about API calls
pub type Endpoint = (RouteBuilderBuilder, hyper_router::Handler, Box<EndpointHandler>);

/// Get a list of all available endpoints
pub fn get_endpoints() -> Vec<Endpoint> {
    vec![(GET("/ping"), ping, Box::new(Ping {})),
         (POST("/v1/blink"), blink, Box::new(Blink {})),
         (POST("/v1/update"), update, Box::new(Update {})),
         (POST("/v1/reboot"), reboot, Box::new(Reboot {})),
         (POST("/v1/shutdown"), shutdown, Box::new(Shutdown {})),
         (POST("/v1/purge"), purge, Box::new(Purge {})),
         (POST("/v1/restart"), restart, Box::new(Restart {})),
         (POST("/v1/tcp-ping"), enable_tcp_ping, Box::new(EnableTcpPing {})),
         (DELETE("/v1/tcp-ping"), disable_tcp_ping, Box::new(DisableTcpPing {})),
         (POST("/v1/regenerate-api-key"), regenerate_api_key, Box::new(RegenerateApiKey {})),
         (POST("/v1/device"), get_device, Box::new(GetDevice {})),
         (POST(r"/v1/apps/\d+/stop"), stop_app, Box::new(StopApp {})),
         (POST(r"/v1/apps/\d/start"), start_app, Box::new(StartApp {})),
         (GET(r"/v1/apps/\d"), get_app, Box::new(GetApp {})),
         (GET("/v1/dependent-apps"), get_dependent_apps, Box::new(GetDependentApps {})),
         (GET(r"/v1/dependent-apps/\d+/assets/[a-fA-F0-9]+"),
          update_app_registery,
          Box::new(UpdateAppRegistry {})),
         (GET("/v1/devices"), get_devices, Box::new(GetDevices {})),
         (POST("/v1/devices"), provision_device, Box::new(ProvisionDevice {})),
         (GET("/v1/devices/[a-fA-F0-9]+"), get_device_info, Box::new(GetDeviceInfo {})),
         (PUT("/v1/devices/[a-fA-F0-9]+"), update_device_info, Box::new(UpdateDeviceInfo {})),
         (POST("/v1/devices/[a-fA-F0-9]+/logs"), log, Box::new(Log {})),
         (POST("/v1/images/create"), create_image, Box::new(CreateImage {})),
         (POST("/v1/images/load"), load_image, Box::new(LoadImage {})),
         (DELETE("/v1/images/.+"), delete_image, Box::new(DeleteImage {})),
         (GET("/v1/images"), list_images, Box::new(ListImgages {})),
         (POST("/v1/containers/create"), create_container, Box::new(CreateContainer {})),
         (POST("/v1/containers/update"), update_container, Box::new(UpdateContainer {})),
         (POST(r"/v1/containers/\d+/start"), start_container, Box::new(StartContainer {})),
         (POST(r"/v1/containers/\d+/stop"), stop_container, Box::new(StopContainer {})),
         (DELETE(r"/v1/containers/\d+"), delete_container, Box::new(DeleteContainer {})),
         (GET("/v1/containers"), list_containers, Box::new(ListContainers {})),
         (POST(r"/v1/apps/\d+/compose/up"), compose_up, Box::new(ComposeUp {})),
         (POST(r"/v1/apps/\d+/compose/down"), compose_down, Box::new(ComposeDown {})),
         (POST("/v1/ipaddr"), id_address, Box::new(IpAddress {})),
         (POST("/v1/vpncontrol"), vpn_control, Box::new(VpnControl {})),
         (POST("/v1/set-log-to-display"), log_to_display_control, Box::new(LogToDisplayControl {}))]
}
