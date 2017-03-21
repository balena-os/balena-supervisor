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

use api::API;
use config::Config;

use hyper;
use hyper_router;
use hyperlocal;

/// Main API server implementation
pub struct Server {
    api: API,
}

impl Server {
    pub fn new(config: Config) -> Server {
        Server { api: API::new(config) }
    }

    /// Run the API server
    pub fn run(config: Config) {
        // Create hyper server
        let hyper_server = hyperlocal::UnixSocketServer::new(&config.listen_address()).unwrap();

        // Create server object
        let server = Server::new(config);

        // Build router
        let mut router = hyper_router::RouterBuilder::new();
        router = server.api.add_routes(router);
        let router = router.build();

        // Run server
        let server_handler = move |request: hyper::server::Request,
                                   mut response: hyper::server::Response| {
            match router.find_handler(&request) {
                Ok(handler) => server.api.dispatch(handler, request, response),
                Err(_) => {
                    *response.status_mut() = hyper::status::StatusCode::NotFound;
                    response.send(b"Invalid URL").unwrap();
                }
            }
        };
        hyper_server.handle(server_handler).unwrap();
    }
}
