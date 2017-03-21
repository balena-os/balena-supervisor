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

use api::endpoints::*;
use api::utils::*;
use application::Application;
use config::Config;
use device::Device;
use network::Network;

use hyper;
use hyper_router;
use std;

/// Struct for API handling
pub struct API {
    pub application: Application,
    pub device: Device,
    pub network: Network,
    endpoints: Vec<Endpoint>,
}

impl API {
    /// Create an API handler
    pub fn new(config: Config) -> API {
        API {
            application: Application::new(config.clone()),
            device: Device::new(config.clone()),
            network: Network::new(config),
            endpoints: get_endpoints(),
        }
    }

    /// Add all available endpoints to the router
    pub fn add_routes(&self,
                      mut router: hyper_router::RouterBuilder)
                      -> hyper_router::RouterBuilder {
        for endpoint in self.endpoints.iter() {
            router = router.add(get_route(endpoint).using(get_id(endpoint)));
        }
        router
    }

    /// Dispatch an API call
    pub fn dispatch(&self,
                    handler: hyper_router::Handler,
                    request: hyper::server::Request,
                    response: hyper::server::Response) {
        let endpoint = self.endpoints.iter().find(|endpoint| {
                                                      get_id(endpoint) as fn(_, _) ==
                                                      handler as fn(_, _)
                                                  });
        if endpoint.is_some() {
            get_handler(endpoint.unwrap()).handle(self, request, response);
        }
    }
}

// TODO: thread safety
unsafe impl std::marker::Send for API {}
unsafe impl std::marker::Sync for API {}
