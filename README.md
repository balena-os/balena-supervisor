# Resin Supervisor ![Build status](http://jenkins.dev.resin.io/buildStatus/icon?job=resin-supervisor-gh) [![Tickets in progress](https://badge.waffle.io/resin-io/resin-supervisor.svg?label=in progress&title=Tickets in progress)](https://waffle.io/resin-io/resin-supervisor)

Join our online chat at [![Gitter chat](https://badges.gitter.im/resin-io/chat.png)](https://gitter.im/resin-io/chat)

This is [resin.io](https://resin.io)'s Supervisor, a program that runs on IoT devices and has the task of running user Apps (which are Docker containers), and updating them as Resin's API informs it to.

The Supervisor is for now a node.js program, with a subset of its functionality implemented in Go.

We are currently **rewriting the whole code in Go**, so if you're interested in contributing, please checkout [the corresponding branch](https://github.com/resin-io/resin-supervisor/tree/RES-477-gosuper-all-the-way) and use that as a base for your PR's (unless it's a bug fix, in which case you can PR to master directly).

We are using [waffle.io](https://waffle.io) to manage our tickets / issues, so if you want to track our progress or contribute take a look at [our board there](https://waffle.io/resin-io/resin-supervisor).

## Running supervisor locally

### Deploy your local version to a Docker registry

We'll show how to use the DockerHub registry, but any other can be specified as part of the `SUPERVISOR_IMAGE` variable.

If you haven't done so yet, login to the registry:
```bash
docker login
```
Use your username and password as required.

Then deploy to a specific repo and tag, e.g.
```bash
make ARCH=amd64 SUPERVISOR_IMAGE=username/resin-supervisor:master deploy
```
This will build the Supervisor docker image if you haven't done it yet, and upload it to the registry.
As we pointed out before, a different registry can be specified with the DEPLOY_REGISTRY env var.

### Set up config.json
Add `tools/dind/config.json` file from a staging device image.

A config.json file can be obtained in several ways, for instance:

* Download an Intel Edison image from staging, open `config.img` with an archive tool like [peazip](http://sourceforge.net/projects/peazip/files/)
* Download a Raspberry Pi 2 image, flash it to an SD card, then mount partition 5 (resin-conf).

The config.json file should look something like this:

(Please note we've added comments to the JSON for better explanation - the actual file should be valid json *without* such comments)
```yaml
{
	"applicationId": "2167", /* Id of the app this supervisor will run */
	"apiKey": "supersecretapikey", /* The API key for the Resin API */
	"userId": "141", /* User ID for the user who owns the app */
	"username": "gh_pcarranzav", /* User name for the user who owns the app */
	"deviceType": "intel-edison", /* The device type corresponding to the test application */
	"files": { /* This field is used by the host OS on devices, so the supervisor doesn't care about it */
		"network/settings": "[global]\nOfflineMode=false\n\n[WiFi]\nEnable=true\nTethering=false\n\n[Wired]\nEnable=true\nTethering=false\n\n[Bluetooth]\nEnable=true\nTethering=false",
		"network/network.config": "[service_home_ethernet]\nType = ethernet\nNameservers = 8.8.8.8,8.8.4.4"
	},
	"apiEndpoint": "https://api.resinstaging.io", /* Endpoint for the Resin API */
	"registryEndpoint": "registry.resinstaging.io", /* Endpoint for the Resin registry */
	"vpnEndpoint": "vpn.resinstaging.io", /* Endpoint for the Resin VPN server */
	"pubnubSubscribeKey": "sub-c-aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", /* Subscribe key for Pubnub for logs */
	"pubnubPublishKey": "pub-c-aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", /* Publish key for Pubnub for logs */
	"listenPort": 48484, /* Listen port for the supervisor API */
	"mixpanelToken": "aaaaaaaaaaaaaaaaaaaaaaaaaa", /* Mixpanel token to report events */
}
```
Additionally, the `uuid`, `registered_at` and `deviceId` fields will be added by the supervisor upon registration with the resin API.

### Start the supervisor instance
```bash
make ARCH=amd64 SUPERVISOR_IMAGE=username/resin-supervisor:master run-supervisor
```
This will setup a docker-in-docker instance with an image that runs the supervisor image.

### Testing with preloaded apps
To test preloaded apps, add a `tools/dind/apps.json` file according to the preloaded apps spec.

It should look something like this:

(As before, please note we've added comments to the JSON for better explanation - the actual file should be valid json *without* such comments)

```yaml
[{
	"appId": "2167", /* Id of the app we are running */
	"commit": "commithash", /* Current git commit for the app */
	"imageId": "registry.resinstaging.io/path/to/image", /* Id of the docker image for this app */
	"env": { /* Environment variables for the app */
		"KEY": "value"
	}
}]
```

Make sure the config.json file doesn't have uuid, registered_at or deviceId populated from a previous run.

Then run the supervisor like this:
```bash
make ARCH=amd64 PRELOADED_IMAGE=true \
	SUPERVISOR_IMAGE=username/resin-supervisor:master run-supervisor
```
This will make the docker-in-docker instance pull the image specified in apps.json before running the supervisor.

### View the containers logs
```bash
docker exec -it resin_supervisor_1 journalctl -f
```

### View the supervisor logs
```bash
docker exec -it resin_supervisor_1 /bin/bash
tail /var/log/supervisor-log/resin_supervisor_stdout.log -f
```

### Stop the supervisor
```bash
make stop-supervisor
```
This will stop the container and remove it, also removing its volumes.

## Working with the Go supervisor
The Dockerfile used to build the Go supervisor is Dockerfile.gosuper, and the code for the Go supervisor lives in the `gosuper` directory.

To build it, run:
```bash
make ARCH=amd64 gosuper
```
This will build and run the docker image that builds the Go supervisor and outputs the executable at `gosuper/bin`.

### Adding Go dependencies
This project uses [Godep](https://github.com/tools/godep) to manage its Go dependencies. In order for it to work, this repo needs to be withing the `src` directory in a valid Go workspace. This can easily be achieved by having the repo as a child of a directory named `src` and setting the `GOPATH` environment variable to such directory's parent.

If these conditions are met, a new dependency can be added with:
```bash
go get github.com/path/to/dependency
```
Then we add the corresponding import statement in our code (e.g. main.go):
```go
import "github.com/path/to/dependency"
```
And we save it to Godeps.json with:
```bash
cd gosuper
godep save -r ./...
```
(The -r switch will modify the import statement to use Godep's `_workspace`)

## Testing
### Gosuper
The Go supervisor can be tested by running:
```bash
make ARCH=amd64 test-gosuper
```
The test suite is at [gosuper/main_test.go](./gosuper/main_test.go).

### Integration test
The integration test tests the supervisor API by hitting its endpoints. To run it, first run the supervisor as explained in the first section of this document.

Once it's running, you can run the test with:
```bash
make ARCH=amd64 test-integration
```
The tests will fail if the supervisor API is down - bear in mind that the supervisor image takes a while to start the actual supervisor program, so you might have to wait a few minutes between running the supervisor and testing it.
The test expects the supervisor to be already running the application (so that the app is already on the SQLite database), so check the dashboard to see if the app has already downloaded.

## License

Copyright 2015 Rulemotion Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
