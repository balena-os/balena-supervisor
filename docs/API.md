# Interacting with the balena Supervisor

The balena Supervisor is balena's agent that runs on devices. Its main role is to ensure your app is running, and keep communications with the balenaCloud API server.

The Supervisor itself has its own set of APIs providing means for user applications to communicate and execute some special actions that affect the host OS or the application itself. There are two main ways for the application to interact with the Supervisor:
- Update lockfile
- HTTP API

Only Supervisors after version `1.1.0` have this functionality, and some of the endpoints appeared in later versions (we've noted it down where this is the case). Supervisor version `1.1.0` corresponds to OS images downloaded after October 14th, 2015.

## HTTP API reference

**Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

The supervisor exposes an HTTP API on port `48484` (`BALENA_SUPERVISOR_PORT`).

To enable these Supervisor environment variables, the `io.balena.features.supervisor-api` label must be applied for each service that requires them. See [here](https://www.balena.io/docs/learn/develop/multicontainer/#labels) for further details.

> Note: All endpoints (except /ping) requires an apikey parameter, which is exposed to the application as `BALENA_SUPERVISOR_API_KEY`.

The full address for the API, i.e. `"http://127.0.0.1:48484"`, is available as `BALENA_SUPERVISOR_ADDRESS`.

> Note: Always use `BALENA_*` variables when communicating via the API, since address and port could change.

Alternatively, the balena API (api.balena-cloud.com) has a proxy endpoint at `POST /supervisor/<url>` (where `<url>` is one of the API URLs described below) from which you can send API commands to the supervisor remotely, using your Auth Token instead of your API key. Commands sent through the proxy can specify either an `appId` to send the request to all devices in an application, or a `deviceId` or `uuid` to send to a particular device. These requests default to POST unless you specify a `method` parameter (e.g. "GET"). In the examples below, we show how to use a uuid to specify a device, but in any of those you can replace `uuid` for a `deviceId` or `appId`.

The API is versioned (currently at v1), except for `/ping`.

You might notice that the formats of some responses differ. This is because they were implemented later, and in Go instead of node.js - even if the Go pieces were later removed, so we kept the response format for backwards compatibility.

Here's the full list of endpoints implemented so far. In all examples, replace everything between `< >` for the corresponding values.

<hr>

### GET /ping

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Responds with a simple "OK", signaling that the supervisor is alive and well.

#### Examples:
From an application container:
```bash
$ curl -X GET --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/ping"
```
Response:
```none
OK
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "method": "GET"}' \
	"https://api.balena-cloud.com/supervisor/ping"
```

<hr>

### POST /v1/blink

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Starts a blink pattern on a LED for 15 seconds, if your device has one.
Responds with an empty 200 response. It implements the "identify device" feature from the dashboard.

#### Examples:
From an application container:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/blink?apikey=$BALENA_SUPERVISOR_API_KEY"
```

(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>"}' \
	"https://api.balena-cloud.com/supervisor/v1/blink"
```

<hr>

### POST /v1/update

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Triggers an update check on the supervisor. Optionally, forces an update when updates are locked.

Responds with an empty 204 (No Content) response.

#### Request body
Can be a JSON object with a `force` property. If this property is true, the update lock will be overridden.
```json
{
	"force": true
}
```

#### Examples:
From an application container:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--data '{"force": true}' \
	"$BALENA_SUPERVISOR_ADDRESS/v1/update?apikey=$BALENA_SUPERVISOR_API_KEY"
```
(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "data": {"force": true}}' \
	"https://api.balena-cloud.com/supervisor/v1/update"
```

<hr>

### POST /v1/reboot

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Reboots the device. This will first try to stop applications, and fail if there is an update lock.
An optional "force" parameter in the body overrides the lock when true (and the lock can also be overridden from
the dashboard).

When successful, responds with 202 accepted and a JSON object:
```json
{
	"Data": "OK",
	"Error": ""
}
```

#### Request body
Can contain a `force` property, which if set to `true` will cause the update lock to be overridden.

#### Examples:
From an application container:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/reboot?apikey=$BALENA_SUPERVISOR_API_KEY"
```
Response:
```json
{
	"Data": "OK",
	"Error": ""
}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>"}' \
	"https://api.balena-cloud.com/supervisor/v1/reboot"
```

<hr>

### POST /v1/shutdown

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

> **Dangerous**: Shuts down the device. This will first try to stop applications, and fail if there is an update lock.
An optional "force" parameter in the body overrides the lock when true (and the lock can also be overridden from the dashboard).

When successful, responds with 202 accepted and a JSON object:
```json
{
	"Data": "OK",
	"Error": ""
}
```

#### Request body
Can contain a `force` property, which if set to `true` will cause the update lock to be overridden.

#### Examples:
From an application container:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/shutdown?apikey=$BALENA_SUPERVISOR_API_KEY"
```
Response:

```json
{
	"Data": "OK",
	"Error": ""
}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>"}' \
	"https://api.balena-cloud.com/supervisor/v1/shutdown"
```

<hr>

### POST /v1/purge

> **Note:** This route will remove and recreate all service containers, as volumes can only be removed when their associated containers are removed. On devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Clears the user application's `/data` folder.

When successful, responds with 200 and a JSON object:
```json
{
	"Data": "OK",
	"Error": ""
}
```

#### Request body
Has to be a JSON object with an `appId` property, corresponding to the ID of the application the device is running. Example:

```json
{
	"appId": 2167
}
```

#### Examples:
From an application container:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--data '{"appId": <appId>}' \
	"$BALENA_SUPERVISOR_ADDRESS/v1/purge?apikey=$BALENA_SUPERVISOR_API_KEY"
```
Response:

```json
{
	"Data": "OK",
	"Error": ""
}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "data": {"appId": <appId>}}' \
	"https://api.balena-cloud.com/supervisor/v1/purge"
```

<hr>

### POST /v1/restart

> **Note:** This route will remove and recreate all service containers. See [the restart action](https://www.balena.io/docs/learn/manage/actions/#restart-application) for more information. On devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

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
From an application container:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--data '{"appId": <appId>}' \
	"$BALENA_SUPERVISOR_ADDRESS/v1/restart?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:

```none
OK
```

Remotely via the API proxy:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "data": {"appId": <appId>}}' \
	"https://api.balena-cloud.com/supervisor/v1/restart"
```

### POST /v1/regenerate-api-key

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Invalidates the current `BALENA_SUPERVISOR_API_KEY` and generates a new one. Responds with the new API key, but **the application will be restarted on the next update cycle** to update the API key environment variable.

#### Examples:
From an application container:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/regenerate-api-key?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:

```none
480af7bb8a9cf56de8a1e295f0d50e6b3bb46676aaddbf4103aa43cb57039364
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>"}' \
	"https://api.balena-cloud.com/supervisor/v1/regenerate-api-key"
```

<hr>

### GET /v1/device

> **Introduced in supervisor v1.6.**

> **Note:** On devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Returns the current device state, as reported to the balenaCloud API and with some extra fields added to allow control over pending/locked updates.
The state is a JSON object that contains some or all of the following:
* `api_port`: Port on which the supervisor is listening.
* `commit`: Hash of the current commit of the application that is running.
* `ip_address`: Space-separated list of IP addresses of the device.
* `mac_address`: Space-separated list of MAC addresses of the device.
* `status`: Status of the device regarding the app, as a string, i.e. "Stopping", "Starting", "Downloading", "Installing", "Idle".
* `download_progress`: Amount of the application image that has been downloaded, expressed as a percentage. If the update has already been downloaded, this will be `null`.
* `os_version`: Version of the host OS running on the device.
* `supervisor_version`: Version of the supervisor running on the device.
* `update_pending`: This one is not reported to the balenaCloud API. It's a boolean that will be true while the Supervisor is checking for updates (such as on boot or every poll interval) or if the supervisor has finally concluded there is an update.
* `update_downloaded`: Not reported to the balenaCloud API either. Boolean that will be true if a pending update has already been downloaded.
* `update_failed`: Not reported to the balenaCloud API. Boolean that will be true if the supervisor has tried to apply a pending update but failed (i.e. if the app was locked, there was a network failure or anything else went wrong).

Other attributes may be added in the future, and some may be missing or null if they haven't been set yet.

#### Examples:
From an application container:
```bash
$ curl -X GET --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/device?apikey=$BALENA_SUPERVISOR_API_KEY"
```
Response:
```json
{
	"api_port":48484,
	"ip_address":"192.168.0.114 10.42.0.3",
	"commit":"414e65cd378a69a96f403b75f14b40b55856f860",
	"status":"Downloading",
	"download_progress":84,
	"os_version":"Resin OS 1.0.4 (fido)",
	"supervisor_version":"1.6.0",
	"update_pending":true,
	"update_downloaded":false,
	"update_failed":false
}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "method": "GET"}' \
	"https://api.balena-cloud.com/supervisor/v1/device"
```

<hr>

### POST /v1/apps/:appId/stop

> **Introduced in supervisor v1.8**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Temporarily stops a user application container. A reboot or supervisor restart will cause the container to start again.
The container is not removed with this endpoint.

This is only supported on single-container devices, and will return 400 on devices running multiple containers. Refer to v2 endpoint, [`/v2/applications/:appId/stop-service`](#post-v2applicationsappidstop-service) for running the query on multiple containers.

When successful, responds with 200 and the Id of the stopped container.

The appId must be specified in the URL.

#### Request body
Can contain a `force` property, which if set to `true` will cause the update lock to be overridden.

#### Examples:
From an application container:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/apps/<appId>/stop?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:

```json
{
	"containerId":"5f4d4a857742e9ecac505ba5710834d3852ad7d71e10389fc6f61d8655a21806"
}
```

Remotely via the API proxy:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>"}' \
	"https://api.balena-cloud.com/supervisor/v1/apps/<appId>/stop"
```

<hr>

### POST /v1/apps/:appId/start

> **Introduced in supervisor v1.8**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Starts a user application container, usually after it has been stopped with `/v1/stop`.

This is only supported on single-container devices, and will return 400 on devices running multiple containers. Refer to v2 endpoint, [`/v2/applications/:appId/start-service`](#post-v2applicationsappidstart-service) for running the query on multiple containers.

When successful, responds with 200 and the Id of the started container.

The appId must be specified in the URL.

#### Examples:
From an application container:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/apps/<appId>/start?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:

```json
{
	"containerId":"6d9e1efdb9aad90fdb2df911f785b6aa00270e9448e75226a9a7361c8a9500cf"
}
```

Remotely via the API proxy:

```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>"}' \
	"https://api.balena-cloud.com/supervisor/v1/apps/<appId>/start"
```

<hr>

### GET /v1/apps/:appId

> **Introduced in supervisor v1.8**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Returns the application running on the device
The app is a JSON object that contains the following:
* `appId`: The id of the app as per the balenaCloud API.
* `commit`: Application commit that is running.
* `imageId`: The docker image of the current application build.
* `containerId`: ID of the docker container of the running app.
* `env`: A key-value store of the app's environment variables.

The appId must be specified in the URL.

This is only supported on single-container devices, and will return 400 on devices running multiple containers. Refer to v2 endpoint, [`/v2/applications/:appId/state`](#get-v2applicationsappidstate) for running the query on multiple containers.

#### Examples:
From an application container:
```bash
$ curl -X GET --header "Content-Type:application/json" \
	"$BALENA_SUPERVISOR_ADDRESS/v1/apps/<appId>?apikey=$BALENA_SUPERVISOR_API_KEY"
```
Response:
```json
{
	"appId": 3134,
	"commit":"414e65cd378a69a96f403b75f14b40b55856f860",
	"imageId":"registry.balena-cloud.com/superapp/414e65cd378a69a96f403b75f14b40b55856f860",
	"containerId":"e5c1eace8b4e",
	"env":{
		"FOO":"bar"
	}
}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "method": "GET"}' \
	"https://api.balena-cloud.com/supervisor/v1/apps/<appId>"
```

<hr>

### GET /v1/healthy

> **Introduced in supervisor v6.5**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Used **internally** to check whether the supervisor is running correctly, according to some heuristics that help determine
whether the internal components, application updates and reporting to the balenaCloud API are functioning.

Responds with an empty 200 response if the supervisor is healthy, or a 500 status code if something is not working
correctly.

#### Examples:
From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v1/healthy"
```
(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "method": "GET"}' \
	"https://api.balena-cloud.com/supervisor/v1/healthy"
```

<hr>

### PATCH /v1/device/host-config

> **Introduced in supervisor v6.6**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

This endpoint allows setting some configuration values for the host OS. Currently it supports
proxy and hostname configuration.

For proxy configuration, balenaOS 2.0.7 and higher provides a transparent proxy redirector (redsocks) that makes all connections be routed to a SOCKS or HTTP proxy. This endpoint allows user applications to modify these proxy settings at runtime.


#### Request body

Is a JSON object with several optional fields. Proxy and hostname configuration go under a "network" key. If "proxy" or "hostname" are not present (undefined), those values will not be modified, so that a request can modify hostname
without changing proxy settings and viceversa.

```json
{
	"network": {
		"proxy": {
			"type": "http-connect",
			"ip": "myproxy.example.com",
			"port": 8123,
			"login": "username",
			"password": "password",
			"noProxy": [ "152.10.30.4", "253.1.1.0/16" ]
		},
		"hostname": "mynewhostname"
	}
}
```

In the proxy settings, `type`, `ip`, `port`, `login` and `password` are the settings for the proxy redirector to
be able to connnect to the proxy, based on how [redsocks.conf](https://github.com/darkk/redsocks/blob/master/redsocks.conf.example) works. `type` can be `socks4`, `socks5`, `http-connect` or `http-relay` (not all proxies are
guaranteed to work, especially if they block connections that the balena services may require).

Keep in mind that, even if transparent proxy redirection will take effect immediately after the API call (i.e. all new connections will go through the proxy), open connections will not be closed. So, if for example, the device has managed to connect to the balenaCloud VPN without the proxy, it will stay connected directly without trying to reconnect through the proxy, unless the connection breaks - any reconnection attempts will then go through the proxy. To force *all* connections to go through the proxy, the best way is to reboot the device (see the /v1/reboot endpoint). In most networks were no connections to the Internet can be made if not through a proxy, this should not be necessary (as there will be no open connections before configuring the proxy settings).

The "noProxy" setting for the proxy is an optional array of IP addresses/subnets that should not be routed through the
proxy. Keep in mind that local/reserved subnets are already [excluded by balenaOS automatically](https://github.com/balena-os/meta-balena/blob/master/meta-balena-common/recipes-connectivity/balena-proxy-config/balena-proxy-config/balena-proxy-config).

If either "proxy" or "hostname" are null or empty values (i.e. `{}` for proxy or an empty string for hostname), they will be cleared to their default values (i.e. not using a proxy, and a hostname equal to the first 7 characters of the device's uuid, respectively).

#### Examples:
From an application container:
```bash
$ curl -X PATCH --header "Content-Type:application/json" \
	--data '{"network": {"hostname": "newhostname"}}' \
	"$BALENA_SUPERVISOR_ADDRESS/v1/device/host-config?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```none
OK
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "method": "PATCH", "data": {"network": {"hostname": "newhostname"}}}' \
	"https://api.balena-cloud.com/supervisor/v1/device/host-config"
```

<hr>

### GET /v1/device/host-config

> **Introduced in supervisor v6.6**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

This endpoint allows reading some configuration values for the host OS, previously set with `PATCH /v1/device/host-config`. Currently it supports
proxy and hostname configuration.

Please refer to the PATCH endpoint above for details on the behavior and meaning of the fields in the response.

#### Examples:
From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v1/device/host-config?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
	"network":{
		"proxy":{
			"ip":"192.168.0.199",
			"port":"8123",
			"type":"socks5"
		},
		"hostname":"27b0fdc"
	}
}
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"uuid": "<uuid>", "method": "GET"}' \
	"https://api.balena-cloud.com/supervisor/v1/device/host-config"
```

### GET /v2/applications/state

> **Introduced in supervisor v7.12**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Get a list of applications, services and their statuses. This will reflect the
current state of the supervisor, and not the target state.

From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/applications/state?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
  "appname": {
    "appId": 1011165,
    "commit": "217d55237092995e4576367e529ebb03",
    "services": {
      "main": {
        "status": "Downloaded",
        "releaseId": 557617,
        "downloadProgress": null
      },
      "frontend": {
        "status": "Downloading",
        "releaseId": 557631,
        "downloadProgress": 0
      },
      "proxy": {
        "status": "Downloaded",
        "releaseId": 557631,
        "downloadProgress": null
      },
      "data": {
        "status": "Downloading",
        "releaseId": 557631,
        "downloadProgress": 7
      },
      "metrics": {
        "status": "Downloading",
        "releaseId": 557631,
        "downloadProgress": 35
      }
    }
  }
}
```


Remotely via the API proxy:
```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <auth token>' \
  -d '{"uuid": "<uuid>", "method": "GET"}' \
  "https://api.balena-cloud.com/supervisor/v2/applications/state"
```

### GET /v2/applications/:appId/state

> **Introduced in supervisor v7.12**

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Use this endpoint to get the state of a single application, given the appId.

From an application container:
```bash
curl "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/state?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
  "local": {
    "1234": {
      "services": {
        "5678": {
          "status": "Running",
          "releaseId": 99999,
          "download_progress": null
        }
      }
    }
  },
  "dependent": {},
  "commit": "7fc9c5bea8e361acd49886fe6cc1e1cd"
}
```

### GET /v2/state/status

> **Introduced in supervisor v9.7**

This will return a list of images, containers, the overall download progress and the status of the state engine.

From an application container:
```bash
curl "$BALENA_SUPERVISOR_ADDRESS/v2/state/status?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
  "status": "success",
  "appState": "applied",
  "overallDownloadProgress": null,
  "containers": [
    {
      "status": "Running",
      "serviceName": "main",
      "appId": 1032480,
      "imageId": 959262,
      "serviceId": 29396,
      "containerId": "be4a860e34ffca609866f8af3596e9ee7b869e1e0bb9f51406d0b120b0a81cdd",
      "createdAt": "2019-03-11T16:05:34.506Z"
    }
  ],
  "images": [
    {
      "name": "registry2.balena-cloud.com/v2/fbf67cf6574fb0f8da3c8998226fde9e@sha256:9e328a53813e3c2337393c63cfd6c2f5294872cf0d03dc9f74d02e66b9ca1221",
      "appId": 1032480,
      "serviceName": "main",
      "imageId": 959262,
      "dockerImageId": "sha256:2662fc0ca0c7dd0f549e87e224f454165f260ff54aac59308d2641d99ca95e58",
      "status": "Downloaded",
      "downloadProgress": null
    }
  ],
  "release": "804281fb17e8291c542f9640814ef546"
}
```

### Service Actions

#### The application ID

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

For the following endpoints the application ID is required in the url. The application ID is exposed as `BALENA_APP_ID` inside your container. Otherwise, you can use the following snippet to determine the application ID programmatically:

```bash
APPNAME="supervisortest"
BALENA_APP_ID=$(curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/state?apikey=$BALENA_SUPERVISOR_API_KEY" | jq ".$APPNAME.appId")
```

The easiest way to find your application from the dashboard is to look at the
url when on the device list.

### POST /v2/applications/:appId/restart-service

> **Note:** This route will remove and recreate the specified service container. See [the restart action](https://www.balena.io/docs/learn/manage/actions/#restart-application) for more information. On devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Added in supervisor version v7.0.0. Support for passing `serviceName` instead of
`imageId` added in v8.2.2.

Use this endpoint to restart a service in the application with application id passed in with the url.

From an application container:
```bash
curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/restart-service?apikey=$BALENA_SUPERVISOR_API_KEY" -d '{"serviceName": "my-service"}'
curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/restart-service?apikey=$BALENA_SUPERVISOR_API_KEY" -d '{"imageId": 1234}'
```

Response:
```
OK
```

This endpoint can also take an extra optional boolean, `force`, which if true informs the supervisor to ignore any update locks which have been taken.

### POST /v2/applications/:appId/stop-service

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Added in supervisor version v7.0.0. Support for passing `serviceName` instead of
`imageId` added in v8.2.2.

Temporarily stops an application's container. Rebooting the device or supervisor will cause the container to start again. The container is not removed with this endpoint.

From an application container:
```bash
curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/stop-service?apikey=$BALENA_SUPERVISOR_API_KEY" -d '{"serviceName": "my-service"}'
curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/stop-service?apikey=$BALENA_SUPERVISOR_API_KEY" -d '{"imageId": 1234}'
```

Response:
```
OK
```

This endpoint can also take an extra optional boolean, `force`, which if true informs the supervisor to ignore any update locks which have been taken.

### POST /v2/applications/:appId/start-service

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Added in supervisor version v7.0.0. Support for passing `serviceName` instead of
`imageId` added in v8.2.2.

Use this endpoint to start a service in the application with application id
passed in with the url.

From an application container:
```bash
curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/start-service?apikey=$BALENA_SUPERVISOR_API_KEY" -d '{"serviceName": "my-service"}'
curl --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/start-service?apikey=$BALENA_SUPERVISOR_API_KEY" -d '{"imageId": 1234}'
```

Response:
```
OK
```

This endpoint can also take an extra optional boolean, `force`, which if true informs the supervisor to ignore any update locks which have been taken.

### POST /v2/applications/:appId/restart

> **Note:** This route will remove and recreate all service containers. See [the restart action](https://www.balena.io/docs/learn/manage/actions/#restart-application) for more information. On devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Added in supervisor version v7.0.0.

Use this endpoint to restart every service in an application.

From an application container:
```bash
curl -X POST --header "Content-Type: application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/restart?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```
OK
```

This endpoint can also take an extra optional boolean, `force`, which if true informs the supervisor to ignore any update locks which have been taken.

### POST /v2/applications/:appId/purge

> **Note:** on devices with supervisor version lower than 7.22.0, replace all `BALENA_` variables with `RESIN_`, e.g. `RESIN_SUPERVISOR_ADDRESS` instead of `BALENA_SUPERVISOR_ADDRESS`.

Added in supervisor version v7.0.0.

Use this endpoint to purge all user data for a given application id.

From an application container:
```bash
curl -X POST --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/applications/$BALENA_APP_ID/purge?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```
OK
```

This endpoint can also take an extra optional boolean, `force`, which if true informs the supervisor to ignore any update locks which have been taken.


### GET /v2/version

> **Introduced in supervisor v7.21**

This endpoint returns the supervisor version currently running the device api.

From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/version?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
	"status": "success",
	"version": "v7.21.0"
}
```

### GET /v2/containerId

> **Introduced in supervisor v8.6**

Use this endpoint to match a service name to a container ID.

From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/containerId?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
	"status": "success",
	"services": {
		"service-one": "ad6d5d32576ad3cb1fcaa59b564b8f6f22b079631080ab1a3bbac9199953eb7d",
		"service-two": "756535dc6e9ab9b560f84c85063f55952273a23192641fc2756aa9721d9d1000"
	}
}
```

You can also specify a service, to return only that container id:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/containerId?apikey=$BALENA_SUPERVISOR_API_KEY&service=service-one"
```

Response:
```json
{
	"status": "success",
	"containerId": "ad6d5d32576ad3cb1fcaa59b564b8f6f22b079631080ab1a3bbac9199953eb7d"
}
```

### Local mode endpoints

These endpoints are mainly for use by the CLI, for working with a local mode device.
As such they are not recommended for general use.

The device must be in local mode before these endpoints are
called, with the exception of `GET /v2/local/target-state`,
which can be called when the device is not in local mode.

### GET /v2/local/target-state

> **Introduced in supervisor v7.21**

Get the current target state. Note that if a local mode target state has not been
set then the apps section of the response will always be empty.

Request:
```bash
curl "$BALENA_SUPERVISOR_ADDRESS/v2/local/target-state"
```

Response:
```json
{
	"status": "success",
	"state": {
		"local": {
			"name": "my-device",
			"config": {
				"HOST_CONFIG_disable_splash": "1",
				"HOST_CONFIG_dtparam": "\"i2c_arm=on\",\"spi=on\",\"audio=on\"",
				"HOST_CONFIG_enable_uart": "1",
				"HOST_CONFIG_gpu_mem": "16",
				"SUPERVISOR_LOCAL_MODE": "1",
				"SUPERVISOR_PERSISTENT_LOGGING": "",
				"SUPERVISOR_POLL_INTERVAL": "600000",
				"SUPERVISOR_VPN_CONTROL": "true",
				"SUPERVISOR_CONNECTIVITY_CHECK": "true",
				"SUPERVISOR_LOG_CONTROL": "true",
				"SUPERVISOR_DELTA": "false",
				"SUPERVISOR_DELTA_REQUEST_TIMEOUT": "30000",
				"SUPERVISOR_DELTA_APPLY_TIMEOUT": "",
				"SUPERVISOR_DELTA_RETRY_COUNT": "30",
				"SUPERVISOR_DELTA_RETRY_INTERVAL": "10000",
				"SUPERVISOR_DELTA_VERSION": "2",
				"SUPERVISOR_OVERRIDE_LOCK": "false"
			},
			"apps": {}
		},
		"dependent": {
			"apps": [],
			"devices": []
		}
	}
}
```

### POST /v2/local/target-state

> **Introduced in supervisor v7.21**

Set the current target state.

Request:
```bash
TARGET_STATE='{
	"local": {
		"name": "Home",
		"config": {
			"HOST_CONFIG_disable_splash": "1",
			"HOST_CONFIG_dtparam": "i2c_arm=on,i2s=on",
			"HOST_CONFIG_enable_uart": "1",
			"HOST_CONFIG_gpio": "\"2=op\",\"3=op\"",
			"HOST_CONFIG_gpu_mem": "16",
			"SUPERVISOR_LOCAL_MODE": "1",
			"SUPERVISOR_POLL_INTERVAL": "600000",
			"SUPERVISOR_VPN_CONTROL": "true",
			"SUPERVISOR_CONNECTIVITY_CHECK": "true",
			"SUPERVISOR_LOG_CONTROL": "true",
			"SUPERVISOR_DELTA": "false",
			"SUPERVISOR_DELTA_REQUEST_TIMEOUT": "30000",
			"SUPERVISOR_DELTA_APPLY_TIMEOUT": "",
			"SUPERVISOR_DELTA_RETRY_COUNT": "30",
			"SUPERVISOR_DELTA_RETRY_INTERVAL": "10000",
			"SUPERVISOR_DELTA_VERSION": "2",
			"SUPERVISOR_OVERRIDE_LOCK": "false",
			"SUPERVISOR_PERSISTENT_LOGGING": "false"
		},
		"apps": {
			"1": {
				"name": "localapp",
				"commit": "localcommit",
				"releaseId": "1",
				"services": {
					"1": {
						"environment": {},
						"labels": {},
						"imageId": 1,
						"serviceName": "one",
						"serviceId": 1,
						"image": "local_image_one:latest",
						"running": true
					},
					"2": {
						"environment": {},
						"labels": {},
						"network_mode": "container:one",
						"imageId": 2,
						"serviceName": "two",
						"serviceId": 2,
						"image": "local_image_two:latest",
						"running": true
					}
				},
				"volumes": {},
				"networks": {}
			}
		}
	},
	"dependent": {
		"apps": [],
		"devices": []
	}
}
'

curl -X POST --header "Content-Type:application/json" "$BALENA_SUPERVISOR_ADDRESS/v2/local/target-state" -d $TARGET_STATE
```

Response:
```json
{
	"status": "success",
	"message": "OK"
}
```

### Get the device type information

> **Introduced in supervisor v7.21**

Get the architecture and device type of the device.

Request:
```bash
curl "$BALENA_SUPERVISOR_ADDRESS/v2/local/device-info"
```

Response:
```json
{
	"status": "success",
	"info": {
		"arch": "armv7hf",
		"deviceType": "raspberry-pi3"
	}
}
```

### Stream local mode application logs from device

> **Introduced in supervisor v7.21**

This endpoint will stream the logs of the applications containers and the supervisor. The logs
come in as NDJSON.

Request:
```bash
curl "$BALENA_SUPERVISOR_ADDRESS/v2/local/logs"
```

Response:
```json
{
	"message": "log line text",
	"timestamp": 1541508467072,
	"serviceName": "main"
}
{
	"message": "another log line",
	"timestamp": 1541508467072,
	"serviceName": "main"
}
```

### V2 Device Information

#### Device name

> **Introduced in supervisor v9.11**

Get the last returned device name from the balena API. Note that this differs from the
`BALENA_DEVICE_NAME_AT_INIT` environment variable provided to containers, as this will
not change throughout the runtime of the container, but the endpoint will always return
the latest known device name.

From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/device/name?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
	"status": "success",
	"deviceName": "holy-wildflower"
}
```

#### Device tags

> **Introduced in supervisor v9.11**

Retrieve any device tags from the balena API. Note that this endpoint will not work when
the device does not have an available connection to the balena API.

From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/device/tags?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
	"status": "success",
	"tags": [
		{
			"id": 188303,
			"name": "DeviceLocation",
			"value": "warehouse #3"
		}
	]
}
```

#### Device VPN Information

> **Introduced in supervisor v11.4**

Retrieve information about the VPN connection running on the device.

From an application container:

```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/device/vpn?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Response:
```json
{
	"status": "success",
	"vpn": {
		"enabled": true,
		"connected": true
	}
}
```

### V2 Utilities

#### Cleanup volumes with no references

> **Introduced in supervisor v10.0**

Starting with balena-supervisor v10.0.0, volumes which have no
references are no longer automatically removed as part of
the standard update flow. To cleanup up any orphaned
volumes, use this supervisor endpoint:

From an application container:
```bash
$ curl "$BALENA_SUPERVISOR_ADDRESS/v2/cleanup-volumes?apikey=$BALENA_SUPERVISOR_API_KEY"
```

Successful response:
```json
{
       "status": "success"
}
```

Unsuccessful response:
```json
{
       "status": "failed",
       "message": "the error message"
}
```

#### Journald logs

> **Introduced in supervisor v10.2**

Retrieve a stream to the journald logs on device. This is
equivalent to running `journalctl --no-pager`. Options
supported are:

##### all: boolean
Show all fields in full, equivalent to `journalctl --all`.

##### follow: boolean
Continuously stream logs as they are generated, equivalent
to `journalctl --follow`.

##### count: integer
Show the most recent `count` events, equivalent to
`journalctl --line=<count>`.

##### unit
Show journal logs from `unit` only, equivalent to
`journalctl --unit=<unit>`.

##### format
> **Introduced in supervisor v10.3**

The format which will be streamed from journalctl, formats
are described here:
https://www.freedesktop.org/software/systemd/man/journalctl.html#-o

Fields should be provided via POST body in JSON format.

From an application container:
```bash
$ curl -X POST -H "Content-Type: application/json" --data '{"follow":true,"all":true}' "$BALENA_SUPERVISOR_ADDRESS/v2/journal-logs?apikey=$BALENA_SUPERVISOR_API_KEY" > log.journal
```

An example project using this endpoint can be found
[in this repository](https://github.com/balena-io-playground/device-cloud-logging).
