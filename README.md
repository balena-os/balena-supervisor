# resin-supervisor [![Tickets in Progress](https://badge.waffle.io/resin-io/resin-supervisor.svg?label=flow/in-progress&title=Tickets%20in%20progress)](https://waffle.io/resin-io/resin-supervisor)

Join our online chat at [![Gitter chat](https://badges.gitter.im/resin-io/chat.png)](https://gitter.im/resin-io/chat)

This is [resin.io](https://resin.io)'s supervisor, a program that runs on IoT devices and has the task of running user Apps (which are Docker containers), and updating them as resin.io's API informs it to.

The supervisor is for now a Node.js program, with a subset of its functionality implemented in Go.

We are using [waffle.io](https://waffle.io) to manage our tickets / issues, so if you want to track our progress or contribute take a look at [our board there](https://waffle.io/resin-io/resin-supervisor).

## Running a supervisor locally

This process will allow you to run a development instance of the supervisor on your local computer. It is not recommended for production scenarios, but allows someone developing on the supervisor to test changes quickly.
The supervisor is run inside a Docker-in-Docker container that roughly emulates its environment when running on a resinOS device.

### Set up `config.json`

Add a `tools/dind/config.json` file from a staging or production device image. It should be configured for an x86 or amd64 device type (e.g. an Intel Nuc) so that you can push apps to it and they run properly on your computer.

Note: Don't use staging for production devices. This is for development purposes only. A production (resin.io) `config.json` should work just as well for this local supervisor, but we also don't recommend using this in production scenarios - resinOS is better suited for that.

A `config.json` file can be obtained in several ways, for instance:

* Log in to the dashboard on resinstaging (https://dashboard.resinstaging.io), create or select an application, click "Download OS" and on the Advanced section select "Download configuration only".
* Install the resin CLI with `npm install -g resin-cli`, then login with `resin login` and finally run `resin config generate --app <appName> -o config.json` (choose the default settings whenever prompted). Check [this section](https://github.com/resin-io/resin-cli#how-do-i-point-the-resin-cli-to-staging) on how to point resin CLI to a device on staging.

The `config.json` file should look something like this:

(Please note we've added comments to the JSON for better explanation - the actual file should be valid json *without* such comments)
```
{
	"applicationId": "2167", /* Id of the app this supervisor will run */
	"apiKey": "supersecretapikey", /* The API key to provision the device on the resin.io API */
	"userId": "141", /* User ID for the user who owns the app */
	"username": "gh_pcarranzav", /* User name for the user who owns the app */
	"deviceType": "intel-nuc", /* The device type corresponding to the test application */
	"apiEndpoint": "https://api.resinstaging.io", /* Endpoint for the resin.io API */
	"deltaEndpoint": "https://delta.resinstaging.io", /* Endpoint for the delta server to download Docker binary diffs */
	"vpnEndpoint": "vpn.resinstaging.io", /* Endpoint for the resin.io VPN server */
	"pubnubSubscribeKey": "sub-c-aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", /* Subscribe key for Pubnub for logs */
	"pubnubPublishKey": "pub-c-aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", /* Publish key for Pubnub for logs */
	"listenPort": 48484, /* Listen port for the supervisor API */
	"mixpanelToken": "aaaaaaaaaaaaaaaaaaaaaaaaaa", /* Mixpanel token to report events */
}
```

Additionally, the `uuid`, `registered_at` and `deviceId` fields will be added by the supervisor upon registration with the resin API. Other fields may be present (the format has evolved over time and will likely continue to do so) but they are not used by the supervisor.

### Start the supervisor instance

Ensure your kernel supports aufs (in Ubuntu, install `linux-image-extra-$(uname -r)`) and the `aufs` module is loaded (if necessary, run `sudo modprobe aufs`).

```bash
./dindctl run --image resin/amd64-supervisor:master
```

This will setup a Docker-in-Docker instance with an image that runs the supervisor image. You can replace `:master` for a specific tag (see the [tags in Dockerhub](https://hub.docker.com/r/resin/amd64-supervisor/tags/)) to run
a supervisor from a branch or specific version. The script will pull the image if it is not already available in your
local Docker instance.

If you want to develop and test your changes, you can run:

```bash
./dindctl run --image resin/amd64-supervisor:master --mount-dist
```

Note: Using `--mount-dist` requires a Node.js 6.x installed on your computer.

This will mount the ./dist folder into the supervisor container and build the code before starting the instance, so that any changes you make can be added to the running supervisor with:

```bash
./dindctl refresh
```

### Testing with preloaded apps
To test preloaded apps, add a `tools/dind/apps.json` file according to the preloaded apps spec.

It should look something like this:

(As before, please note we've added comments to the JSON for better explanation - the actual file should be valid json *without* such comments)

```
[{
	"appId": "2167", /* Id of the app we are running */
	"name": "myapplication", /* Name of the app we are running */
	"commit": "commithash", /* Current git commit for the app */
	"imageId": "registry.resinstaging.io/path/to/image", /* Id of the Docker image for this app */
	"env": { /* Environment variables for the app */
		"KEY": "value"
	},
	"config": { /* Device configuration variables */
		"RESIN_SUPERVISOR_DELTA": "1"
	}
}]
```

Make sure the `config.json` file doesn't have uuid, registered_at or deviceId populated from a previous run.

Then run the supervisor like this:
```bash
./dindctl run --image resin/amd64-supervisor:master --preload
```
This will make the Docker-in-Docker instance pull the image specified in `apps.json` before running the supervisor, simulating a preloaded resinOS image (where `resin preload` has been used on the image, see [the resin CLI docs](https://docs.resin.io/tools/cli/#preload-60-image-62-)).

### Enabling passwordless dropbear access

If you want to enable passwordless dropbear login (e.g. while testing `resin sync`) you can set the `--ssh` option, like:

```bash
./dindctl run --image resin/amd64-supervisor:master --ssh
```

This will run an ssh daemon **with no password** inside the Docker-in-Docker instance, so use with caution.

### View the supervisor's logs
```bash
./dindctl logs
```

This will show the output of `journalctl` inside the Docker-in-Docker container. You can pass
additional options, for instance, to see the logs from the supervisor service:

```bash
./dindctl logs -fn 100 -u resin-supervisor-dind
```

### Stop the supervisor
```bash
./dindctl stop
```
This will stop the container and remove it, also removing its volumes.

## Developing with a resinOS device

If you want to test local changes (only changes to the Node.js code are supported) on a real resinOS device, provision
a [development OS image](https://docs.resin.io/understanding/understanding-devices/2.0.0/#dev-vs-prod-images) and power up the device. On the resin.io dashboard, take note of the device's IP address. Then run:
```
./sync.js <device IP>
```

This will build the supervisor code and sync it onto the running supervisor container inside the device, and then restart it.

## Build a local supervisor image

This should rarely be needed as `--mount-dist` allows you to test any changes to the Node.js code without a full rebuild. However, if you've changed code in gosuper, base-image or the Dockerfile you will need to build the proper
supervisor Docker image.

Build the supervisor with a specific tag, and for a specific architecture, like this:
```bash
./dindctl build --tag master --arch amd64
```

This will build the supervisor Docker image locally. If you then run `docker images` you should see the repo/tag you
set there. Keep in mind several images will be pulled for caching purposes - if the base image is not cached the build
can take a few hours.

The Docker caching system can be tricky, so it might try to build the base image anyways; if you see that the build hangs at something like:

```
### Shell environment set up for builds. ###

You can now run 'bitbake <target>'

Common targets are:
    core-image-minimal
    core-image-sato
    meta-toolchain
    meta-ide-support

You can also run generated qemu images with a command like 'runqemu qemux86'
```

...don't be alarmed, it means it is building the base image and will take a few hours without any output. Go grab some coffee or play a game of Risk.

## Working with the Go supervisor

The code for the Go supervisor lives in the `gosuper` directory.

To build it, run (with the ARCH and IMAGE you want):
```bash
make ARCH=amd64 IMAGE=username/gosuper:master gosuper
```
This will build a Docker image that builds the Go supervisor and has the executable at /go/bin/gosuper inside the image.

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
