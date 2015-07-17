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
godep save -r ./...
```
(The -r switch will modify the import statement to use Godep's `_workspace`)
