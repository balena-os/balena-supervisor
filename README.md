# Running supervisor in the dev env

## Deploy your local version to the devenv registry
If you haven't done so yet, login to the devenv registry:
```bash
docker login registry.resindev.io
```
Use username "resin" and the registry's [default login details](https://bitbucket.org/rulemotion/resin-builder/src/4594c0020dcae2c98e4b3d7bab718b088bb7e52a/config/confd/templates/env.tmpl?at=master#cl-9) if you haven't changed them.
```bash
make ARCH=amd64 deploy
```
This will build the image if you haven't done it yet.
A different registry can be specified with the DEPLOY_REGISTRY env var.

## Set up config
Edit `tools/dind/config.json` to contain the values for a staging config.json.

This file can be obtained in several ways, for instance:

* Download an Intel Edison image from staging, open `config.img` with an archive tool like [peazip](http://sourceforge.net/projects/peazip/files/)
* Download a Raspberry Pi 2 image, flash it to an SD card, then mount partition 5 (resin-conf).

Tip: to avoid git marking config.json as modified, you can run:
```bash
git update-index --assume-unchanged tools/dind/config.json
```

## Start the supervisor instance
```bash
make ARCH=amd64 run-supervisor
```
This will setup a docker-in-docker instance with an image that runs the supervisor image.

By default it will pull from the devenv registry (registry.resindev.io).

A different registry can be specified with the DEPLOY_REGISTRY env var.

e.g.
```bash
make ARCH=amd64 DEPLOY_REGISTRY= run-supervisor
```
to pull the jenkins built images from the docker hub.

## View the containers logs
```bash
logs supervisor -f
```

## View the supervisor logs
```bash
enter supervisor
tail /var/log/supervisor-log/resin_supervisor_stdout.log -f
```

## Stop the supervisor
```bash
make stop-supervisor
```
This will stop the container and remove it, also removing its volumes.

# Working with the Go supervisor
The Dockerfile used to build the Go supervisor is Dockerfile.gosuper, and the code for the Go supervisor lives in the `gosuper` directory.

To build it, run:
```bash
make ARCH=amd64 gosuper
```
This will build and run the docker image that builds the Go supervisor and outputs the executable at `gosuper/bin`.

## Adding Go dependencies
This project uses [Godep](https://github.com/tools/godep) to manage its Go dependencies. In order for it to work, this repo needs to be withing the `src` directory in a valid Go workspace. This can easily be achieved in the devenv by having the repo in the devenv's `src` directory and setting the `GOPATH` environment variable to such directory's parent (that is, the `resin-containers` directory).

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
# Gosuper
The Go supervisor can be tested by running:
```bash
make ARCH=amd64 test-gosuper
```
The test suite is at [gosuper/main_test.go](./gosuper/main_test.go).
# Integration test
The integration test tests the supervisor API by hitting its endpoints. To run it, first run the supervisor as explained in the first section of this document.

Once it's running, you can run the test with:
```bash
make ARCH=amd64 test-integration
```
The tests will fail if the supervisor API is down - bear in mind that the supervisor image takes a while to start the actual supervisor program, so you might have to wait a few minutes between running the supervisor and testing it.
The test expects the supervisor to be already running the application (so that the app is already on the SQLite database), so check the dashboard to see if the app has already downloaded.
