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

//! Internal utilities for handling API calls

use api::endpoints::Endpoint;
use api::handlers::{APIError, EndpointHandler};

use hyper;
use hyper_router;
use rustc_serialize;
use std::io::Read;

/// Generate a consumable Router Builder
pub type RouteBuilderBuilder = Box<Fn() -> hyper_router::RouteBuilder>;

/// Get the route from a detail::Endpoint tuple
pub fn get_route(endpoint: &Endpoint) -> hyper_router::RouteBuilder {
    endpoint.0()
}

/// Get the route ID from a detail::Endpoint tuple
pub fn get_id(endpoint: &Endpoint) -> hyper_router::Handler {
    endpoint.1
}

/// Get the handler from a detail::Endpoint tuple
pub fn get_handler<'h>(endpoint: &'h Endpoint) -> &'h Box<EndpointHandler> {
    &endpoint.2
}

/// Declare a GET path
#[allow(non_snake_case)]
pub fn GET(path: &'static str) -> RouteBuilderBuilder {
    Box::new(move || hyper_router::Route::get(path))
}

/// Declare a POST path
#[allow(non_snake_case)]
pub fn POST(path: &'static str) -> RouteBuilderBuilder {
    Box::new(move || hyper_router::Route::post(path))
}

/// Declare a PUT path
#[allow(non_snake_case)]
pub fn PUT(path: &'static str) -> RouteBuilderBuilder {
    Box::new(move || hyper_router::Route::put(path))
}

/// Declare a DELETE path
#[allow(non_snake_case)]
pub fn DELETE(path: &'static str) -> RouteBuilderBuilder {
    Box::new(move || hyper_router::Route::delete(path))
}

/// Deserialize and return request parameters
pub fn get_params<Params>(request: &mut hyper::server::Request,
                          response: &mut hyper::server::Response)
                          -> Result<Params, String>
    where Params: rustc_serialize::Decodable
{
    let mut body: String = "".to_string();
    match request.read_to_string(&mut body) {
        Ok(_) => get_params_from_json(&body, response),
        Err(error) => {
            *response.status_mut() = hyper::status::StatusCode::InternalServerError;
            Err(error.to_string())
        }
    }
}

/// Deserialize and return request parameters
fn get_params_from_json<Params>(body: &String,
                                response: &mut hyper::server::Response)
                                -> Result<Params, String>
    where Params: rustc_serialize::Decodable
{
    let decoded = rustc_serialize::json::decode::<Params>(&body);
    match decoded {
        Ok(params) => Ok(params),
        Err(error) => {
            *response.status_mut() = hyper::status::StatusCode::BadRequest;
            Err(error.to_string())
        }
    }
}

/// Send error message and code through given response
pub fn handle_error(error: APIError, mut response: hyper::server::Response) {
    match error {
        APIError::Locked => {
            *response.status_mut() = hyper::status::StatusCode::Locked;
        }
        APIError::FailedWithError(error_str) => {
            *response.status_mut() = hyper::status::StatusCode::InternalServerError;
            response.send(error_str.as_bytes()).unwrap();
        }
        APIError::Failed => {
            *response.status_mut() = hyper::status::StatusCode::InternalServerError;
            response.send(b"Unknown error").unwrap();
        }
    }
}

/// Serialize and send a response object
pub fn send_response<Response>(result: Response, response: hyper::server::Response)
    where Response: rustc_serialize::Encodable
{
    let result = rustc_serialize::json::encode::<Response>(&result);
    response.send(result.unwrap().as_bytes()).unwrap();
}
