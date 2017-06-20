# Requirements to run Resin Supervisor

This document describes what the Supervisor requires from the OS in order to run properly and for all features to work.
See [start-resin-supervisor in meta-resin](https://github.com/resin-os/meta-resin/blob/master/meta-resin-common/recipes-containers/docker-disk/docker-resin-supervisor-disk/start-resin-supervisor) for the precise way in which the supervisor is started in Resin OS.

## Software on the host

* Kernel support for iptables with REJECT targets.
* systemd with dbus
* docker, listening on a unix socket
* kmod (only on Resin OS 1.X)

## Bind mounts

* The system root (`/`) must be mounted at `/mnt/root`. See [below](#paths-in-rootfs) for the paths from the host that are actually used.
* The Docker socket must be mounted at `DOCKER_SOCKET`, and currently that *has* to be at `/var/run/docker.sock` for deltas to work.
* A config.json file must be mounted at `/boot/config.json`.
* An apps.json file can be mounted at `/boot/apps.json` for preloaded apps.
* A `/data` folder must be mounted for persistent storage (used to store the sqlite database). In Resin OS we use `/resin-data/resin-supervisor` for this.

`/var/log`, `/mnt/fib_trie` and `/etc/resolv.conf` used to be required bind mounts but are no longer used. `/etc/resolv.conf` is now mounted automatically by docker.

## Paths in rootfs

From the bind mounted rootfs, the supervisor uses the following directories (appending `/mnt/root` to access them:

* `/proc` (or as pointed by `HOST_PROC`), used to add OOM protection to the supervisor and VPN.
* `/var/lib/docker` (or as pointed to by `DOCKER_ROOT`, which actually defaults to `/mnt/root/var/lib/rce`), used by deltas to access the image filesystems.
* `/tmp/resin-supervisor` is used to mount the paths for update locks. It's created if it doesn't exist, but *must* be cleared by the OS on reboot (i.e. `/tmp` must be a proper tmpfs).
* `/run/dbus/system_bus_socket` is the DBUS system bus, used to talk to the host systemd. `/run/dbus` is also mounted to app containers.
* `/bin/kmod` (only on Resin OS 1.X) - bind mounted into app containers
* `/resin-data` (or as pointed by `RESIN_DATA_PATH`) is where we store containers' `/data`.
* `/lib/modules` and `/lib/firmware` are bind mounted to app containers.
* `/var/lib/connman` (only on Resin OS 1.X) - bind mounted into app containers.
* `/run/openvpn/vpn_status` or as pointed by `VPN_STATUS_PATH` is used to monitor the status of the VPN connection. See [upscript.sh and downscript.sh in meta-resin](https://github.com/resin-os/meta-resin/tree/master/meta-resin-common/recipes-connectivity/openvpn/openvpn) for how this is configured. If it doesn't exist, connectivity check uses a TCP ping to the API server.
* `/etc/os-release` (or as pointed by `HOST_OS_VERSION_PATH`) is used to determine the host OS version, and change some behavior depending on whether it's a Resin OS and its version.
* `/boot` or as pointed to by `BOOT_MOUNTPOINT` (in Resin OS 2.0, this is `/mnt/boot`) is used to access config.txt in Raspberry Pi devices.

## Systemd services

Accessed via systemd's dbus interface.

* `systemd-logind` is used for reboot and shutdown.
* `resin-info@tty1.service` is used to enabled/disable logs to display. `tty-replacement.service` is used as a fallback if the other one doesn't exist (legacy).
* `openvpn-resin.service` is used to enable/disable the Resin VPN.

## Env vars

* `DOCKER_SOCKET=/var/run/docker.sock`. Different values will not allow deltas to work. Must match the docker socket mount path.
* `HOST_PROC` path to `/proc` on the host, defaults to `/mnt/root/proc`.
* `DOCKER_ROOT` defaults to `/mnt/root/var/lib/rce`, and should point to the docker root via the root bind mount. In Resin OS it's currently `/mnt/root/var/lib/docker`.
* `LISTEN_PORT` is the port for the Supervisor API, defaults to 80 but in Resin OS we use 48484.
* `API_ENDPOINT` is the Resin API that manages this device. If empty, the device will work in offline mode. Example: `https://api.resin.io`.
* `BOOT_MOUNTPOINT` mount point for the boot partition, defaults to `/boot` but in Resin OS we use `/mnt/boot`.
* `PUBNUB_SUBSCRIBE_KEY`, `PUBNUB_PUBLISH_KEY` and `MIXPANEL_TOKEN` are keys for PubNub (logs) and Mixpanel (event tracking). They default to values that are injected to the supervisor at build-time.
* `DELTA_ENDPOINT` is used to get image deltas. Defaults to `https://delta.resin.io`.
* `LED_FILE` is the path of the LED to use for blink patterns (to identify the device or report broken connectivity). Defaults to `/dev/null`.
* `SUPERVISOR_IMAGE` is the image for the supervisor container, defaults to `resin/ARCH-supervisor` where `ARCH` is the architecture (armv7hf, i386, etc.). Used to avoid cleaning it up.
* `APPLICATION_UPDATE_POLL_INTERVAL` can be used to change the time between requests for the target state to the Resin API. Defaults to 1 minute.
* `VPN_STATUS_PATH` and `HOST_OS_VERSION_PATH` default to `/mnt/root/run/openvpn/vpn_status` and `/mnt/root/etc/os-release` and are paths to monitor VPN status and get the OS version as described [above](#paths-in-rootfs).

The following env vars are optional and rarely (if ever) used:
* `RESIN_SUPERVISOR_SECRET` and `RESIN_SUPERVISOR_LOGS_CHANNEL` are used during development to force the supervisor to use those values instead of random ones. Do not use in production.
* `API_TIMEOUT` can be used to configure the timeouts when doing requests to the Resin API, in milliseconds. Defaults  to 15 minutes.
* `BOOTSTRAP_RETRY_DELAY_MS` can be used to change the time between provisioning attempts. Defaults to 30 seconds.

`REGISTRY_ENDPOINT` used to be necessary to know from where to pull images, but it is no longer used.

## Future changes

Things that are in progress:
* A `ROOT_MOUNTPOINT` env var can be used to change where the host filesystem is mounted
* I'll fix `DOCKER_SOCKET` so that it doesn't have to be at `/var/run` (otherwise the env var makes no sense and it's less backwards compatible). It should also be replaced with `DOCKER_HOST`.
* A `CONFIG_JSON_PATH` env var will be used to specify the config.json path *on the host*, and it will be accessed via the root bind mount.
* `API_ENDPOINT`, `LISTEN_PORT`, the pubnub and mixpanel keys, `DELTA_ENDPOINT`, `APPLICATION_UPDATE_POLL_INTERVAL`, and `API_TIMEOUT` will be extracted directly from camelCased fields in config.json instead of using env vars. The `API_ENDPOINT` can still fall back to the env var if config.json doesn't have it if we want to maintain support for extremely old devices.

Things that we can discuss:
* Should we make the apps.json path configurable?