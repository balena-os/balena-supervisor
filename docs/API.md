# Interacting with the Resin Supervisor

The Resin Supervisor is resin.io's agent that runs on devices. Its main role is to ensure your app is running, and keep communications with the Resin API server.

The Supervisor itself has its own API, with means for user applications to communicate and execute some special actions that affect the host OS or the application itself. There are two main ways for the application to interact with the Supervisor: the update lockfile and the HTTP API.

Only Supervisors after version 1.1.0 have this functionality, and some of the endpoints appeared in later versions (we've noted it down where this is the case). Supervisor version 1.1.0 corresponds to OS images downloaded after October 14th 2015.

## HTTP API reference

The supervisor exposes an HTTP API on port 48484 (`RESIN_SUPERVISOR_PORT`).

**All endpoints require an apikey parameter, which is exposed to the application as `RESIN_SUPERVISOR_API_KEY`.**

The full address for the API, i.e. `"http://127.0.0.1:48484"`, is available as `RESIN_SUPERVISOR_ADDRESS`. **Always use these variables when communicating via the API, since address and port could change**.

Alternatively, the Resin API (api.resin.io) has a proxy endpoint at `POST /supervisor/<url>` (where `<url>` is one of the API URLs described below) from which you can send API commands to the supervisor remotely, using your Auth Token instead of your API key. Commands sent through the proxy require an `appId` and/or `deviceId` parameter in the body, and default to POST requests unless you specify a `method` parameter (e.g. "GET").

The API is versioned (currently at v1), except for `/ping`.

You might notice that the formats of some responses differ. This is because they were implemented later, and in Go instead of node.js.

Here's the full list of endpoints implemented so far. In all examples, replace everything between `< >` for the corresponding values.

<hr>

### GET /ping

Responds with a simple "OK", signaling that the supervisor is alive and well.

#### Examples:
From the app on the device:
```bash
$ curl -X GET --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/ping?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:
```none
OK
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "method": "GET"}' \
	"https://api.resin.io/supervisor/ping"
```

<hr>

### POST /v1/blink

Starts a blink pattern on a LED for 15 seconds, if your device has one.
Responds with an empty 200 response. It implements the "identify device" feature from the dashboard.

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/blink?apikey=$RESIN_SUPERVISOR_API_KEY"
```

(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/blink"
```

<hr>

### POST /v1/update

Triggers an update check on the supervisor. Optionally, forces an update when updates are locked.

Responds with an empty 204 (Accepted) response.

#### Request body
Can be a JSON object with a `force` property. If this property is true, the update lock will be overridden.
```json
{
	"force": true
}
```

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--data '{"force": true}' \
	"$RESIN_SUPERVISOR_ADDRESS/v1/update?apikey=$RESIN_SUPERVISOR_API_KEY"
```
(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "data": {"force": true}}"' \
	"https://api.resin.io/supervisor/v1/update"
$
```

<hr>

### POST /v1/reboot

Reboots the device

When successful, responds with 204 accepted and a JSON object:
```json
{
	"Data": "OK",
	"Error": ""
}
```
(This is implemented in Go)

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/reboot?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:
```json
{"Data":"OK","Error":""}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/reboot"
```

<hr>

### POST /v1/shutdown

**Dangerous**. Shuts down the device.

When successful, responds with 204 accepted and a JSON object:
```json
{
	"Data": "OK",
	"Error": ""
}
```
(This is implemented in Go)

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/shutdown?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:

```json
{"Data":"OK","Error":""}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/shutdown"
```

<hr>

### POST /v1/purge

Clears the user application's `/data` folder.

When successful, responds with 200 and a JSON object:
```json
{
	"Data": "OK",
	"Error": ""
}
```

(This is implemented in Go)

#### Request body
Has to be a JSON object with an `appId` property, corresponding to the ID of the application the device is running.

Example:

```json
{
	"appId": 2167
}
```

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--data '{"appId": <appId>}' \
	"$RESIN_SUPERVISOR_ADDRESS/v1/purge?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:

```none
{"Data":"OK","Error":""}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "data": {"appId": <appId>}}' \
	"https://api.resin.io/supervisor/v1/purge"
```

<hr>

### POST /v1/restart

Restarts a user application container

When successful, responds with 200 and an "OK"

#### Request body
Has to be a JSON object with an `appId` property, corresponding to the ID of the application the device is running.

Example:

```json
{
	"appId": 2167
}
```

#### Examples:
From the app on the device:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--data '{"appId": <appId>}' \
	"$RESIN_SUPERVISOR_ADDRESS/v1/restart?apikey=$RESIN_SUPERVISOR_API_KEY"
```

Response:

```none
OK
```

Remotely via the API proxy:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "data": {"appId": <appId>}}' \
	"https://api.resin.io/supervisor/v1/restart"
```

<hr>

### POST /v1/tcp-ping

When the device's connection to the Resin VPN is down, by default the device performs a TCP ping heartbeat to check for connectivity. This endpoint enables such TCP ping in case it has been disabled (see DELETE /v1/tcp-ping).

When successful, responds with an empty 204:

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/tcp-ping?apikey=$RESIN_SUPERVISOR_API_KEY"
```

(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/tcp-ping"
```

<hr>

### DELETE /v1/tcp-ping

When the device's connection to the Resin VPN is down, by default the device performs a TCP ping heartbeat to check for connectivity. This endpoint disables such TCP ping.

When successful, responds with an empty 204:

#### Examples:
From the app on the device:
```bash
$ curl -X DELETE --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/tcp-ping?apikey=$RESIN_SUPERVISOR_API_KEY"
```

(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "method": "DELETE"}' \
	"https://api.resin.io/supervisor/v1/tcp-ping"
```

### POST /v1/regenerate-api-key

Invalidates the current `RESIN_SUPERVISOR_API_KEY` and generates a new one. Responds with the new API key, but **the application will be restarted on the next update cycle** to update the API key environment variable.

#### Examples:
From the app on the device:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/regenerate-api-key?apikey=$RESIN_SUPERVISOR_API_KEY"
```

Response:

```none
480af7bb8a9cf56de8a1e295f0d50e6b3bb46676aaddbf4103aa43cb57039364
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/regenerate-api-key"
```

<hr>

### GET /v1/device

Introduced in supervisor v1.6.
Returns the current device state, as reported to the Resin API and with some extra fields added to allow control over pending/locked updates.
The state is a JSON object that contains some or all of the following:
* `api_port`: Port on which the supervisor is listening.
* `commit`: Hash of the current commit of the application that is running.
* `ip_address`: Space-separated list of IP addresses of the device.
* `status`: Status of the device regarding the app, as a string, i.e. "Stopping", "Starting", "Downloading", "Installing", "Idle".
* `download_progress`: Amount of the application image that has been downloaded, expressed as a percentage. If the update has already been downloaded, this will be `null`.
* `os_version`: Version of the host OS running on the device.
* `supervisor_version`: Version of the supervisor running on the device.
* `update_pending`: This one is not reported to the Resin API. It's a boolean that will be true if the supervisor has detected there is a pending update.
* `update_downloaded`: Not reported to the Resin API either. Boolean that will be true if a pending update has already been downloaded.
* `update_failed`: Not reported to the Resin API. Boolean that will be true if the supervisor has tried to apply a pending update but failed (i.e. if the app was locked, there was a network failure or anything else went wrong).

Other attributes may be added in the future, and some may be missing or null if they haven't been set yet.

#### Examples:
From the app on the device:
```bash
$ curl -X GET --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/device?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:
```json
{"api_port":48484,"ip_address":"192.168.0.114 10.42.0.3","commit":"414e65cd378a69a96f403b75f14b40b55856f860","status":"Downloading","download_progress":84,"os_version":"Resin OS 1.0.4 (fido)","supervisor_version":"1.6.0","update_pending":true,"update_downloaded":false,"update_failed":false}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "method": "GET"}' \
	"https://api.resin.io/supervisor/v1/device"
```

<hr>

### POST /v1/apps/:appId/stop

Introduced in supervisor v1.8.
Temporarily stops a user application container. A reboot or supervisor restart will cause the container to start again.
The container is not removed with this endpoint.

When successful, responds with 200 and the Id of the stopped container.

The appId must be specified in the URL.

#### Request body
Can contain a `force` property, which if set to `true` will cause the update lock to be overridden.

#### Examples:
From the app on the device:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/apps/<appId>/stop?apikey=$RESIN_SUPERVISOR_API_KEY"
```

Response:

```json
{"containerId":"5f4d4a857742e9ecac505ba5710834d3852ad7d71e10389fc6f61d8655a21806"}
```

Remotely via the API proxy:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/apps/<appId>/stop"
```

<hr>

### POST /v1/apps/:appId/start

Introduced in supervisor v1.8.
Starts a user application container, usually after it has been stopped with `/v1/stop`.

When successful, responds with 200 and the Id of the started container.

The appId must be specified in the URL.

#### Examples:
From the app on the device:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/apps/<appId>/start?apikey=$RESIN_SUPERVISOR_API_KEY"
```

Response:

```json
{"containerId":"6d9e1efdb9aad90fdb2df911f785b6aa00270e9448e75226a9a7361c8a9500cf"}
```

Remotely via the API proxy:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>}' \
	"https://api.resin.io/supervisor/v1/apps/<appId>/start"
```

<hr>

### GET /v1/apps/:appId

Introduced in supervisor v1.8.
Returns the application running on the device
The app is a JSON object that contains the following:
* `appId`: The id of the app as per the Resin API.
* `commit`: Application commit that is running.
* `imageId`: The docker image of the current application build.
* `containerId`: ID of the docker container of the running app.
* `env`: A key-value store of the app's environment variables.

The appId must be specified in the URL.

#### Examples:
From the app on the device:
```bash
$ curl -X GET --header "Content-Type:application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/apps/<appId>?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:
```json
{"appId": 3134,"commit":"414e65cd378a69a96f403b75f14b40b55856f860","imageId":"registry.resin.io/superapp/414e65cd378a69a96f403b75f14b40b55856f860","containerId":"e5c1eace8b4e","env":{"FOO":"bar"}}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "method": "GET"}' \
	"https://api.resin.io/supervisor/v1/apps/<appId>"
```

<hr>

## API endpoints for image and container management

Supervisor 1.9 introduces these endpoints to allow users to create images and containers from the app. These endpoints are designed to be
as close as possible to the corresponding endpoints from the Docker Remote API. We chose this approach instead of just exposing the docker socket
because we need the supervisor to track the containers and images to avoid cleaning them up unwantedly.

All examples are shown as posted from the app on the device, as this is the intended use, but the API proxy works like with the other endpoints.

Refer to the [Docker API docs](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22) for detailed descriptions of request parameters and response formats.

### POST /v1/images/create

Works like [/images/create from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#create-an-image).
Allows the creation of images by pulling them from a registry or from a tar archive.

#### Example:

Creating an image from a tarball:
```bash
$ curl -X POST --data-binary @hello-master.tar \
	"$RESIN_SUPERVISOR_ADDRESS/v1/images/create?fromSrc=-&repo=hello&tag=master&apikey=$RESIN_SUPERVISOR_API_KEY"
```

Pulling from DockerHub:
```bash
$ curl -X POST \
	"$RESIN_SUPERVISOR_ADDRESS/v1/images/create?fromImage=alpine&tag=latest&apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### POST /v1/images/load

Works like [/images/load from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#load-a-tarball-with-a-set-of-images-and-tags-into-docker).
Allows the creation of images from a tar archive produced by `docker save`.

#### Example:

```bash
$ curl -X POST --data-binary @images.tar \
	"$RESIN_SUPERVISOR_ADDRESS/v1/images/load?apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### DELETE /v1/images/:name

Deletes image with name `name`. Works like [DELETE /images/(name) from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#remove-an-image).
Will only work if `name` is sent as the `repo:tag` used for creating the image.

#### Example:

```bash
$ curl -X DELETE \
	"$RESIN_SUPERVISOR_ADDRESS/v1/images/hello:master?apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### GET /v1/images

Works like [GET /images/json from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#list-images).

#### Example:

```bash
$ curl -X GET \
	"$RESIN_SUPERVISOR_ADDRESS/v1/images?apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### POST /v1/containers/create

Works like [/containers/create from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#create-a-container).
Can only be used with `Image` specifying a `repo:tag` created with /v1/images/create.

#### Example:

```
$ curl -X POST --data '{"Image":"alpine:latest","Cmd":["sh","-c", "while true; do echo hi; sleep 5; done"]}' -H "Content-Type: application/json" \
	"$RESIN_SUPERVISOR_ADDRESS/v1/containers/create?apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### POST /v1/containers/:id/start

Starts a container. Works like [/containers/(id)/start from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#start-a-container).
The id can be extracted from the response of /v1/containers/create.

#### Example:

```
$ curl -X POST \
	"$RESIN_SUPERVISOR_ADDRESS/v1/containers/ac072860f31a9df31dea72f8418d193e6af257b4fed4008f86097200fba45966/start?apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### POST /v1/containers/:id/stop

Stops a container. Works like [/containers/(id)/stop from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#stop-a-container).
As with start, the id can be extracted from the response of /v1/containers/create.

#### Example:

```
$ curl -X POST \
	"$RESIN_SUPERVISOR_ADDRESS/v1/containers/ac072860f31a9df31dea72f8418d193e6af257b4fed4008f86097200fba45966/stop?apikey=$RESIN_SUPERVISOR_API_KEY"
```

<hr>

### DELETE /v1/containers/:id

Deletes a container. Works like [DELETE /containers/(id) from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#remove-a-container).
The id can be extracted from the response of /v1/containers/create.

#### Example:

```
$ curl -X DELETE \
	"$RESIN_SUPERVISOR_ADDRESS/v1/containers/ac072860f31a9df31dea72f8418d193e6af257b4fed4008f86097200fba45966?apikey=$RESIN_SUPERVISOR_API_KEY"
```

### GET /v1/containers

Lists containers. Works like [GET /containers/json from the Docker API](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.22/#list-containers).

#### Example:

```
$ curl -X GET \
	"$RESIN_SUPERVISOR_ADDRESS/v1/containers?apikey=$RESIN_SUPERVISOR_API_KEY"
```
