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

### POST /v1/spawn-tty

Starts a web terminal session.

When successful, responds with 200 and the URL of the terminal.

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
	"$RESIN_SUPERVISOR_ADDRESS/v1/spawn-tty?apikey=$RESIN_SUPERVISOR_API_KEY"
```
Response:
```none
http://124135325.ngrok.com
```

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "data": {"appId": <appId>}}' \
	"https://api.resin.io/supervisor/v1/spawn-tty"
```

<hr>

### POST /v1/despawn-tty

Stops a web terminal session.

When successful, responds with an empty 200 response.

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
	"$RESIN_SUPERVISOR_ADDRESS/v1/despawn-tty?apikey=$RESIN_SUPERVISOR_API_KEY"
```

(Empty response)

Remotely via the API proxy:
```bash
$ curl -X POST --header "Content-Type:application/json" \
	--header "Authorization: Bearer <auth token>" \
	--data '{"deviceId": <deviceId>, "appId": <appId>, "data": {"appId": <appId>}}' \
	"https://api.resin.io/supervisor/v1/despawn-tty"
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

When successful, responds with 200 and a
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
