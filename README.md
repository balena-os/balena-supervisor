# Resin Supervisor [![Tickets in Progress](https://badge.waffle.io/resin-io/resin-supervisor.svg?label=flow/in-progress&title=Tickets%20in%20progress)](https://waffle.io/resin-io/resin-supervisor)

Join our online chat at [![Gitter chat](https://badges.gitter.im/resin-io/chat.png)](https://gitter.im/resin-io/chat)

This is [resin.io](https://resin.io)'s Supervisor, a program that runs on IoT devices and has the task of running user Apps (which are Docker containers), and updating them as Resin's API informs it to.

The Supervisor is for now a node.js program, with a subset of its functionality implemented in Go.

We are using [waffle.io](https://waffle.io) to manage our tickets / issues, so if you want to track our progress or contribute take a look at [our board there](https://waffle.io/resin-io/resin-supervisor).

## Running supervisor locally

### Build a local supervisor image

Build the supervisor with a specific repo and tag, e.g.
```bash
./tools/dev/dindctl build --image username/resin-supervisor:master --arch amd64
```

This will build the Supervisor docker image locally. If you then run `docker images` you should see the repo/tag you
set there.

### Set up config.json

Add a `tools/dind/config.json` file from a staging device image. It should be configured for an x86 or amd64 device type so that you can push apps to it and they run properly on your computer.

Note: don't use resinstaging for production devices. This is for development purposes only. A production (resin.io) config.json should work just as fine for this local supervisor, but we also don't recommend using this in production scenarios - ResinOS is way better suited for that.

A config.json file can be obtained in several ways, for instance:

* Log in to the dashboard on resinstaging (https://dashboard.resinstaging.io), create or select an application, click "Download OS" and on the Advanced section select "Download configuration only".
* Install the Resin CLI with `npm install -g resin-cli`, then login with `resin login` and finally run `resin config generate --app <appName> -o config.json` (choose the default settings whenever prompted). Check [this section](https://github.com/resin-io/resin-cli#how-do-i-point-the-resin-cli-to-staging) on how to point Resin CLI to a device on staging.

The config.json file should look something like this:

(Please note we've added comments to the JSON for better explanation - the actual file should be valid json *without* such comments)
```yaml
{
	"applicationId": "2167", /* Id of the app this supervisor will run */
	"apiKey": "supersecretapikey", /* The API key for the Resin API */
	"userId": "141", /* User ID for the user who owns the app */
	"username": "gh_pcarranzav", /* User name for the user who owns the app */
	"deviceType": "intel-edison", /* The device type corresponding to the test application */
	"apiEndpoint": "https://api.resinstaging.io", /* Endpoint for the Resin API */
	"deltaEndpoint": "https://delta.resinstaging.io", /* Endpoint for the delta server to download docker binary diffs */
	"vpnEndpoint": "vpn.resinstaging.io", /* Endpoint for the Resin VPN server */
	"pubnubSubscribeKey": "sub-c-aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", /* Subscribe key for Pubnub for logs */
	"pubnubPublishKey": "pub-c-aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", /* Publish key for Pubnub for logs */
	"listenPort": 48484, /* Listen port for the supervisor API */
	"mixpanelToken": "aaaaaaaaaaaaaaaaaaaaaaaaaa", /* Mixpanel token to report events */
	"files": { /* This field is used by the host OS on devices, so the supervisor doesn't care about it */
		"network/settings": "[global]\nOfflineMode=false\n\n[WiFi]\nEnable=true\nTethering=false\n\n[Wired]\nEnable=true\nTethering=false\n\n[Bluetooth]\nEnable=true\nTethering=false",
		"network/network.config": "[service_home_ethernet]\nType = ethernet\nNameservers = 8.8.8.8,8.8.4.4"
	},
	"registryEndpoint": "registry.resinstaging.io", /* Endpoint for the Resin registry, not used by the latest supervisor versions */
}
```

Additionally, the `uuid`, `registered_at` and `deviceId` fields will be added by the supervisor upon registration with the resin API. Other fields may be present (the format has evolved over time and will likely continue to do so).

### Start the supervisor instance

Ensure your kernel supports aufs (in Ubuntu, install `linux-image-extra-$(uname -r)`) and the `aufs` module is loaded (if necessary, run `sudo modprobe aufs`).

```bash
./tools/dev/dindctl run --image username/resin-supervisor:master
```

This will setup a docker-in-docker instance with an image that runs the supervisor image. The image has to be available
locally, either because you built it as described above, or because you pulled it before running `dindctl run`.

If you want to develop and test your changes, you can run:

```bash
./tools/dev/dindctl run --image username/resin-supervisor:master --mount-dist
```

This will mount the ./dist folder into the supervisor container, so that any changes you make can be added to the running supervisor with:

```bash
./tools/dev/dindctl refresh
```

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
./tools/dev/dindctl run --image username/resin-supervisor:master --preload
```
This will make the docker-in-docker instance pull the image specified in apps.json before running the supervisor.

### Enabling passwordless dropbear access

If you want to enable passwordless dropbear login (e.g. while testing `resin sync`) you can set the `PASSWORDLESS_DROPBEAR` option to `true`, like:

```bash
PASSWORDLESS_DROPBEAR=true ARCH=amd64 SUPERVISOR_IMAGE=username/resin-supervisor:master ./tools/dev/dindctl run
```

### View the containers logs
```bash
docker exec -it resin_supervisor_1 journalctl -f
```

### View the supervisor logs
```bash
./tools/dev/dindctl logs -f
```

### Stop the supervisor
```bash
./tools/dev/dindctl stop
```
This will stop the container and remove it, also removing its volumes.

## Working with the Go supervisor

The code for the Go supervisor lives in the `gosuper` directory.

To build it, run (with the ARCH and IMAGE you want):
```bash
make ARCH=amd64 IMAGE=username/gosuper:master gosuper
```
This will build a docker image that builds the Go supervisor and has the executable at /go/bin/gosuper inside the image.

### Adding Go dependencies
This project uses [glide](https://github.com/Masterminds/glide) to manage its Go dependencies. Refer to its repository for instructions on adding packages.

In order for go utilities to work, this repo needs to be within the `src` directory in a valid Go workspace. This can easily be achieved by having the repo as a child of a directory named `src` and setting the `GOPATH` environment variable to such directory's parent.

## Testing

We're working on adding more tests to this repo, but here's what you can run in the meantime:

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

## Contributing

If you're interested in contributing, that's awesome!

Here's a few guidelines to make the process easier for everyone involved.

* Every PR *should* have an associated issue, and the PR's opening comment should say "Fixes #issue" or "Closes #issue".
* We use [Versionist](https://github.com/resin-io/versionist) to manage versioning (and in particular, [semantic versioning](semver.org)) and generate the changelog for this project.
* At least one commit in a PR should have a `Change-Type: type` footer, where `type` can be `patch`, `minor` or `major`. The subject of this commit will be added to the changelog.
* Commits should be squashed as much as makes sense.
* Commits should be signed-off (`git commit -s`)

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
