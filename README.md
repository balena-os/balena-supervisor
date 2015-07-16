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
```
enter supervisor
tail /var/log/supervisor-log/resin_supervisor_stdout.log -f
```

## Stop the supervisor
`make stop-supervisor`
This will unmount /var/lib/docker in the container and then stop it.

This prevents future failures due to no loopback devices being available.
