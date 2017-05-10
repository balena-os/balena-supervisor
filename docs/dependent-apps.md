# Using the Resin Supervisor to manage dependent applications

Since version 2.5.0 the Resin Supervisor can act as a proxy for dependent apps.

Only Supervisors after version 2.5.0 have this functionality, and some of the endpoints appeared in later versions (we've noted it down where this is the case).

## What is a dependent application

A **dependent application** is a resin application that targets devices not capable of interacting directly with the Resin API - the reasons can be several, the most common are:

- no direct Internet capabilities
- not able to run Resin OS (being a microcontroller, for example)

The **dependent application** is scoped under a resin application, which gets the definition of **gateway application**.

The **gateway application** is responsible for detecting, provisioning and managing **dependent devices** belonging to one of its **dependent applications**. This is possible leveraging a new set of endpoints exposed by the Resin Supervisor.

When a new version of the dependent application is git pushed, the supervisor will download the docker image and expose the assets in one of the endpoints detailed below. It is then the gateway application (i.e. the user app that is run by the supervisor) that is responsible for ensuring those assets get deployed to the dependent devices, using the provided endpoints to perform the management.

A dependent application follows the same development cycle of a conventional resin application:

- it binds to your git workspace via the **resin remote**
- it consists in a Docker application
- it offers the same environment and configuration variables management

There are some differences:

- it does not support Dockerfile templating
- the Dockerfile must target either an `x86` or `amd64` base image
- the actual firmware/business logic must be stored in the `/assets` folder within the built docker image.
  - You can either just `COPY` a pre-built artifact in that folder, or build your artifact at push time and then store it in the `/assets` folder.
- **a dependent application Docker image is only used to build, package and deliver the firmware on the dependent device via resin-supervisor - it won't be run at any point.**

## How a dependent application works

### Endpoints

The supervisor exposes a REST API to interact with the dependent applications and dependent devices models that come from the Resin API - it also allows using a set of hooks to have push functionality, both documented below.

# HTTP API reference

## Applications

### GET /v1/dependent-apps
Dependent Applications List

**Example**

```bash
curl -X GET $RESIN_SUPERVISOR_ADDRESS/v1/dependent-apps?apikey=$RESIN_SUPERVISOR_API_KEY
```

**Response**
`HTTP/1.1 200 OK`

```javascript
[
     {
         "id": 13015,
         "device_type": "edge",
         "name": "edgeApp1",
         "commit": "d43bea5e16658e653088ce4b9a91b6606c3c2a0d",
         "config": {},
         "environment": {}
     },
     {
         "id": 13016,
         "device_type": "edge",
         "name": "edgeApp2",
         "commit": "d0f6624d6410fa079159fa3ebe0d3af46753d75d",
         "config": {},
         "environment": {}
     }
 ]
```

### GET /v1/dependent-apps/:appId/assets/:commit
Dependent Application Updates Registry

**Example**

```bash
curl -X GET $RESIN_SUPERVISOR_ADDRESS/v1/dependent-apps/<appId>/assets/<commit>?apikey=$RESIN_SUPERVISOR_API_KEY
```

**Response**
`HTTP/1.1 200 OK`


```none
[application/x-tar] .tar
```

### GET /v1/dependent-apps/:appId/devices
Dependent Application Devices List

**Example**

```bash
curl -X GET $RESIN_SUPERVISOR_ADDRESS/v1/dependent-apps/<appId>/devices
```

**Response**
`HTTP/1.1 200 OK`


```javascript
[
     {
         "id": 1,
         "localId": "00:A0:C9:14:C8:29",
         "uuid": "5ae8cf6e062c033ea38435498ad9b487bcc714e9eab0fed0404ee56e397790",
         "appId": 13015,
         "device_type": "edge",
         "logs_channel": "69f961abffaad1ff66031b29f712be4fb19e1bfabf1fee7a9ebfb5fa75a1fbdb",
         "deviceId": "47270",
         "is_online": null,
         "name": "blue-sun",
         "status": "Provisioned",
         "download_progress": null,
         "commit": "d43bea5e16658e693088ce4b9a91b6606c3c2a0d",
         "targetCommit": "d43bea5e16653e653088ce4b9a91b6606c3c2a0d",
         "environment":{},
         "targetEnvironment":{},
         "config":{},
         "targetConfig":{"RESIN_SUPERVISOR_DELTA":"1"}
     },
     {
         "id": 3,
         "localId": "0ed28cc954b0",
         "uuid": "8dc608765fd32665d49d218a7eb4657bc2ab8a56db06d2c57ef7c7e9a115da",
         "appId": 13015,
         "device_type": "edge",
         "logs_channel": "d0244a90e8cd6e9a1ab410d3d599dea7f15110a6fe37b2a8fd69bb6ee0bce043",
         "deviceId": "47318",
         "is_online": null,
         "name": "wild-paper",
         "status": "Provisioned",
         "download_progress": null,
         "commit": "d43bea5e16658e253088ce4b9a91b6606c3c2a0d",
         "targetCommit": "d43bea5e11658e653088ce4b9a91b6606c3c2a0d",
         "environment":{},
         "targetEnvironment":{},
         "config":{},
         "targetConfig":{"RESIN_SUPERVISOR_DELTA":"1"}
     }
 ]
```

## Devices

### GET /v1/devices
Dependent Devices List

**Example**

```bash
curl -X GET $RESIN_SUPERVISOR_ADDRESS/v1/devices?apikey=$RESIN_SUPERVISOR_API_KEY
```

**Response**
`HTTP/1.1 200 OK`


```javascript
[
     {
         "id": 1,
         "localId": "00:A0:C9:14:C8:29",
         "uuid": "5ae8cf6e062c033ea38435498ad9b487bcc714e9eab0fed0404ee56e397790",
         "appId": 13015,
         "device_type": "edge",
         "logs_channel": "69f961abffaad1ff66031b29f712be4fb19e1bfabf1fee7a9ebfb5fa75a1fbdb",
         "deviceId": "47270",
         "is_online": null,
         "name": "blue-sun",
         "status": "Provisioned",
         "download_progress": null,
         "commit": "d43bea5e16658e693088ce4b9a91b6606c3c2a0d",
         "targetCommit": "d43bea5e16653e653088ce4b9a91b6606c3c2a0d",
         "environment":{},
         "targetEnvironment":{},
         "config":{},
         "targetConfig":{"RESIN_SUPERVISOR_DELTA":"1"}
     },
     {
         "id": 3,
         "localId": "0ed28cc954b0",
         "uuid": "8dc608765fd32665d49d218a7eb4657bc2ab8a56db06d2c57ef7c7e9a115da",
         "appId": 13015,
         "device_type": "edge",
         "logs_channel": "d0244a90e8cd6e9a1ab410d3d599dea7f15110a6fe37b2a8fd69bb6ee0bce043",
         "deviceId": "47318",
         "is_online": null,
         "name": "wild-paper",
         "status": "Provisioned",
         "download_progress": null,
         "commit": "d43bea5e16658e253088ce4b9a91b6606c3c2a0d",
         "targetCommit": "d43bea5e11658e653088ce4b9a91b6606c3c2a0d",
         "environment":{},
         "targetEnvironment":{},
         "config":{},
         "targetConfig":{"RESIN_SUPERVISOR_DELTA":"1"}
     }
 ]
```

### POST /v1/devices
Dependent Device Provision

**Example**

```bash
curl -H "Content-Type: application/json" -X POST --data '{"appId": <appId>, "localId": <localId>}' /
$RESIN_SUPERVISOR_ADDRESS/v1/devices?apikey=$RESIN_SUPERVISOR_API_KEY
```

**Response**
`HTTP/1.1 201 CREATED`


```javascript
{
          "id": 47318,
            "uuid": "8dc608765fd32665d49a268a7eb4657bc2ab8a56db06d2c57ef7c7e9a115da",
      "name": "wild-paper",
          "note": null,
          "device_type": "edge",
    }
```

### GET /v1/devices/:uuid
Dependent Device Information

**Example**

```bash
curl -X GET $RESIN_SUPERVISOR_ADDRESS/v1/devices/<uuid>?apikey=$RESIN_SUPERVISOR_API_KEY
```

**Response**
`HTTP/1.1 200 OK`

```javascript
{
           "id": 1,
           "localId": "0ed28cc954b0",
           "uuid": "5ae8cf6e062c033ea57837498ad9b487bfc714e9eab0fed0404ee56e397790",
           "appId": 13015,
           "device_type": "edge",
           "logs_channel": "69f961abffaad2ff00031b29f718be4fb19e1bfabf1fee7a9ebfb5fa75a1fbdb",
           "deviceId": "47270",
           "is_online": null,
           "name": "blue-sun",
           "status": "Provisioned",
           "download_progress": null,
           "commit": "d43bea5e16658e623088je4b9a91b6606c3c2a0d",
           "targetCommit": "d43bea5e16658e651088ce4b9a21b6606c3c2a0d",
           "env": null,
           "targetEnv": null
       }
```

### PUT /v1/devices/:uuid
Dependent Device Information Update

**Example**

```bash
curl -H "Content-Type: application/json" -X PUT --data /
'{"is_online":true, "status": "Updating", "commit": "339125a7529cb2c2a8c93a0bbd8af69f2d96286ab4f4552cb5cfe99b0d3ee9"}' /
$RESIN_SUPERVISOR_ADDRESS/v1/devices/<uuid>?apikey=$RESIN_SUPERVISOR_API_KEY
```

**Response**
`HTTP/1.1 200 OK`

```javascript
{
           "id": 1,
           "localId": "0ed28cc954b0",
           "uuid": "5ae8cf6e062c033ea38437498ad9b482bcc714e9eab0fed0404ee56e397790",
           "appId": 13015,
           "device_type": "edge",
           "logs_channel": "69f961abffaad2ff66031b29f712be4fb19e1bfabf1fee7a9ebfb5fa05a1fbdb",
           "deviceId": "47270",
           "is_online": true,
           "name": "blue-sun",
           "status": "Updating",
           "download_progress": null,
           "commit": "d43bea5e16658e653088ce4b9a11b6606c3c2a0d",
           "targetCommit": "d43bea5e16658e653088se4b9a91b6606c3c2a0d",
           "env": null,
           "targetEnv": null
       }
```

### POST /v1/devices/:uuid/logs
Dependent Device Log

**Example**

```bash
curl -H "Content-Type: application/json" -X POST --data '{"message":"detected movement","timestamp":1472142960}' /
$RESIN_SUPERVISOR_ADDRESS/v1/devices/<uuid>/logs?apikey=$RESIN_SUPERVISOR_API_KEY
```
**Response**
`HTTP/1.1 202 ACCEPTED`

## Hooks (the requests the Resin Supervisor performs)

### Hook configuration

You can point the supervisor where to find the hook server via a configuration variable.

- `RESIN_DEPENDENT_DEVICES_HOOK_ADDRESS` _(defaults to `http://0.0.0.0:1337/v1/devices/`)_

It's worth mentioning (as described below) that the supervisor will append the dependent device uuid (`<uuid>` in the hook descriptions) to every hook request URL

### PUT /v1/devices/:uuid/restart
Dependent Device Restart Notification

**Example**

```bash
curl -H "Content-Type: application/json" -X PUT /
http://127.0.0.1:1337/v1/devices/<uuid>/restart
```
**Response**
* `HTTP/1.1 200 OK`
* `HTTP/1.1/ 501 NOT IMPLEMENTED`

### PUT /v1/devices/:uuid/identify
Dependent Device Identify Notification

**Example**

```bash
curl -H "Content-Type: application/json" -X PUT /
http://127.0.0.1:1337/v1/devices/<uuid>/identify
```
**Response**
* `HTTP/1.1 200 OK`
* `HTTP/1.1/ 501 NOT IMPLEMENTED`

### PUT /v1/devices/:uuid
Dependent Device Update Notification

**Example**

```bash
curl -H "Content-Type: application/json" -X PUT /
--data '{"commit":" <commit>","environment": "<environment>"}' http://127.0.0.1:1337/v1/devices/<uuid>
```
**Responses**
* `HTTP/1.1 200 OK` Acknowledgement of the notification without further trials: The Supervisor won't repeat the hook request
* `HTTP/1.1 202 ACCEPTED`Acknowledgement of the notification with validation: the Supervisor will repeat the hook request until the dependent device information gets updated via `Dependent Device Information Update` endpoint

### DELETE /v1/devices/:uuid
Dependent Device Delete Notification

**Example**

```bash
curl -X DELETE http://127.0.0.1:1337/v1/devices/<uuid>
```
**Response**
`HTTP/1.1 200 OK`
