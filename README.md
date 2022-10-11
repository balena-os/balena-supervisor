# balenaSupervisor

balenaSupervisor is [balena](https://balena.io)'s on-device
agent, responsible for monitoring and applying changes to an
IoT device. It communicates with balenaCloud and handles the
lifecycle of an IoT application.

Using the [balenaEngine](https://balena.io/engine)'s (our
IoT-centric container engine) remote API, balenaSupervisor
will install, start, stop and monitor IoT applications,
delivered and ran as [OCI](https://www.opencontainers.org/)
compliant containers.

balenaSupervisor is developed using Node.js.

## Contributing

If you're interested in contributing, that's awesome!

> Contributions are not only pull requests! Bug reports and
> feature requests are also extremely value additions.

### Issues

Feature request and bug reports should be submitted via
issues. One of the balenaSupervisor team will reply and work
with the community to plan a route forward. Although we may
never implement the feature, taking the time to let us know
what you as a user would like to see really helps our
decision making processes!

### Pull requests

Here's a few guidelines to make the process easier for everyone involved.

- Every PR _should_ have an associated issue, and the PR's opening comment should say "Fixes #issue" or "Closes #issue".
- We use [Versionist](https://github.com/resin-io/versionist) to manage versioning (and in particular, [semantic versioning](https://semver.org)) and generate the changelog for this project.
- At least one commit in a PR should have a `Change-Type: type` footer, where `type` can be `patch`, `minor` or `major`. The subject of this commit will be added to the changelog.
- Commits should be squashed as much as makes sense.
- Commits should be signed-off (`git commit -s`)

## Setup

To get the codebase setup on your development machine follow these steps. For running the supervisor on a device see [Developing the supervisor](#developing-the-supervisor) or [Using balenaOS-in-container](#using-balenaos-in-container).

```sh
# Clone the repo
git clone git@github.com:balena-os/balena-supervisor.git

# Install dependencies
npm ci
```

We explicitly use `npm ci` over `npm install` to ensure the correct package versions are installed. More documentation for this can be found [here](https://docs.npmjs.com/cli/ci) on the npm cli docs.

You're now ready to start developing. If you get stuck at some point please reference the [troubleshooting](#troubleshooting) section before creating an issue.

## Developing the supervisor

By far the most convenient way to develop the supervisor is
to download a development image of balenaOS from the
dashboard, and run it on a device you have to hand. You can
then use the local network to sync changes using
[livepush](http://github.com/balena-io-modules/livepush) and
`npm run sync`.

If you do not have a device available, it's possible to run
a supervisor locally, using
[balenaOS-in-container](https://github.com/balena-os/balenaos-in-container).
These steps are detailed below.

### Sync

Example:

```bash
# Replace amd64 with your device architecture
$ npm run sync -- d19baeb.local -a amd64

> balena-supervisor@10.11.3 sync /home/cameron/Balena/modules/balena-supervisor
> ts-node --project tsconfig.json sync/sync.ts "d19baeb.local"

Step 1/23 : ARG ARCH=amd64
Step 2/23 : ARG NODE_VERSION=10.19.0
Step 3/23 : FROM balenalib/$ARCH-alpine-supervisor-base:3.11 as BUILD
...
```

> Note: For .local resolution to work you must have installed
> and enabled MDNS. Alternatively you can use the device's
> local IP.

Sync will first run a new build on the target device (or
balenaOS container), after livepush has processed the
livepush specific commands and will start the new supervisor
image on device.

The supervisor logs are then streamed back from the device,
and livepush will then watch for changes on the local FS,
and sync any relevant file changes to the running supervisor
container. It will then decide if the container should be
restarted, or let nodemon handle the changes.

### Using balenaOS-in-container

This process will allow you to run a development instance of the supervisor on your local computer. It is not recommended for production scenarios, but allows someone developing on the supervisor to test changes quickly.
The supervisor is run inside a balenaOS instance running in a container, so effectively it's a Docker-in-Docker instance (or more precisely, [balenaEngine](https://github.com/resin-os/balena-engine)-in-Docker).

To run the supervisor in a balenaOS-in-container instance, first follow the installation instructions on the [balenaOS-in-container repository](https://github.com/balena-os/balenaos-in-container/). Make sure
you have the image configured in [development mode](https://www.balena.io/docs/reference/OS/overview/#development-vs-production-mode). After the image starts you should be able to use the [sync](#Sync) method described above for running a livepush Supervisor on the docker container.

```bash
# Replace d19baeb.local with the container address.
$ npm run sync -- d19baeb.local -a amd64

> balena-supervisor@10.11.3 sync /home/cameron/Balena/modules/balena-supervisor
> ts-node --project tsconfig.json sync/sync.ts "d19baeb.local"
```

## Developing using a production image or device

A production balena image does not have an open docker
socket, required for livepush to work. In this situation, [balena tunnel](https://www.balena.io/docs/reference/balena-cli/#tunnel-deviceorfleet)
can be used to tunnel the necessary ports to the local development machine.

For a balena device on a different network:

```bash
# Open tunnel using the device uuid
balena tunnel <uuid> -p 22222
# Tunnel device ports to the local machine
ssh -ACN -p 22222 \
-L 2375:/var/run/balena-engine.sock \
-L 48484:127.0.0.1:48484 \
root@localhost
# On another terminal
npm run sync -- 127.0.0.1 -a amd64
```

For a balena device on the local network, the `balena tunnel` step is not necessary.

```bash
# Tunnel device ports to the local machine
# replace d19baeb.local below with the local network address
# of the balena device
ssh -ACN -p 22222 \
-L 2375:/var/run/balena-engine.sock \
-L 48484:127.0.0.1:48484 \
-L 22222:127.0.0.1:22222 \
root@d19baeb.local
# On another terminal
npm run sync -- 127.0.0.1 -a amd64
```

## Building

The supervisor is built automatically by the CI system, but a docker image can be also be built locally using the [balena CLI](https://www.balena.io/docs/reference/balena-cli/#build-source).

To build a docker image for amd64 targets, it's as simple as:

```bash
balena build -d genericx86-64-ext -A amd64
```

For other architectures, the argument to `-A` must be replaced with the proper architecture and the correct device type must be
passed using `-d`.

> Available architectures: `amd64`, `i386`, `aarch64`,
> `armv7hf` and `rpi`

For instance to build for raspberrypi4:

```bash
balena build -d raspberrypi4-64 -A aarch64
```

### Developer documentation
To build the TypeDoc developer documentation, use the command below. If you change `docs/supervisor-arch.odg` in LibreOffice Draw, first export the changes to `docs/supervisor-arch-svg`.

```bash
typedoc --out typedocs --includes docs --entryPointStrategy expand ./src
```

Browse to the `app` modules at `typedocs/modules/app.html` for an overview of code organization.

## Testing

The codebase splits the test suite into unit and integration tests. While unit tests can be run in the local development machine,
integration tests require a containerized environment with the right dependencies to be setup.

To run type checks, and unit tests, you can use:

```
npm run test
```

The supervisor runs on Node v12.16.2, so using that specific
version will ensure tests run in the same environment as
production.

In order to run all tests, unit and integration, [docker-compose](https://docs.docker.com/compose/) is required.
The following command will build the image for an `amd64` target (running `test` during the build) and setup
the necessary dependencies for running integration tests.

```
npm run test:compose
```

This is the same process that happens in the Supervisor repository CI system, to ensure released supervisor versions have been
properly tested.

Alternatively, you can launch a test environment using the following commands.

```
# Launch the environment
npm run test:env

# In another terminal, access the sut container
docker-compose exec -i sut sh

# Or alternatively, access the sut container using docker exec
docker exec -ti $(docker ps -q --filter="name=_sut") sh
```

And then run all tests using

```
npm run test:node
```

For more information about testing the Supervisor, see the [testing README](test/README.md).

#### Running specific tests quickly

You can run specific tests quickly with the `test:unit` script or the `test:integration` script (if working in a test environment) by matching with test suites (describe) or test cases (it) using a string or regexp:

```sh
npm run test:unit -- -g "JSON utils"

npm run test:unit -- -g "detect a V2 delta"

npm run test:unit -- -g "(GET|POST|PUT|DELETE)"
```

The `--grep` option, when specified, will trigger mocha to only run tests matching the given pattern which is internally compiled to a RegExp.

## Troubleshooting

Make sure you are running at least:

```sh
node -v       # >= 12.16.2
npm -v        # >= 6.14.4
git --version # >= 2.13.0
```

Also, ensure you're installing dependencies with `npm ci` as this will perform a clean install and guarantee the module versions specified are downloaded rather then installed which might attempt to upgrade!

If you have upgraded system packages and find that your tests are failing to initialize with docker network errors, a reboot may resolve this. See [this issue](https://github.com/moby/moby/issues/34575) for details.

### DBus

When developing on macOS you may need to install DBus on the development host.

1. `brew install dbus`
2. `npm ci`

On Debian-based systems, `sudo apt install libdbus-1-dev` would be the equivalent.

#### Downgrading versions

The Supervisor will always be forwards compatible so you can just simply run newer versions. If there is data that must be normalized to a new schema such as the naming of engine resources, values in the sqlite database, etc then the new version will automatically take care of that either via [migrations](/src/migrations) or at runtime when the value is queried.

However, these transformations of data are one way. You cannot run older versions of the Supervisor because the migrations are tracked in the sqlite database which will cause exceptions to be thrown once the Supervisor detects the source code is missing migration scripts that the database has. To resolve this just return to your previous Supervisor version or upgrade to the latest version if you don't remember.

## License

Copyright 2020 Balena Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
