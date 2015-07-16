# Running supervisor in the dev env

## Deploy your local version to the devenv registry
If you haven't done so yet, login to the devenv registry:
```
docker login registry.resindev.io
```
Use username "resin" and the registry's [default login details](https://bitbucket.org/rulemotion/resin-builder/src/4594c0020dcae2c98e4b3d7bab718b088bb7e52a/config/confd/templates/env.tmpl?at=master#cl-9) if you haven't changed them.
```
make ARCH=amd64 deploy
```
This will build the image if you haven't done it yet.
A different registry can be specified with the DEPLOY_REGISTRY env var.

## Set up config
Edit `tools/dind/config.json` to contain the values for a staging config.json.

Example (replace the first four values from a staging config for your own app):
```
{
    "applicationId": "1939",
    "apiKey": "saf987fasXKPz82anHASGAlovP",
    "userId": "141",
    "username": "gh_pcarranzav",
    "deviceType": "raspberry-pi2",
    "files": {
        "network/settings": "[global]\nOfflineMode=false\n\n[WiFi]\nEnable=true\nTethering=false\n\n[Wired]\nEnable=true\nTethering=false\n\n[Bluetooth]\nEnable=true\nTethering=false",
        "network/network.config": "[service_home_ethernet]\nType = ethernet\nNameservers = 8.8.8.8,8.8.4.4"
    }
}
```

## Start the supervisor instance
```
make ARCH=amd64 run-supervisor
```
This will setup a docker-in-docker instance with an image that runs the supervisor image.

By default it will pull from the devenv registry (registry.resindev.io).

A different registry can be specified with the DEPLOY_REGISTRY env var.

## View the containers logs
```
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
