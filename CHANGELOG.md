* Stop all apps before rebooting or shutting down [Pablo]
* Catch exec format error and provide friendlier error message [Aleksis]

# v2.1.0

* Pick up new variable from hostOS, pointing to the mount point of the hostOS's boot partition [Theodor]

# v2.0.0

* **[Breaking]** Change the logger to send at a specific interval and with a different message format [Pablo]

# v1.14.0

* Allow using an HTTP header for auth [Pablo]
* Add iptables rules to block requests to the supervisor API from all interfaces except vpn, docker and local [Pablo]

# v1.13.2

* bootstrap: if offlineMode is enabled, persist only the uuid [petrosagg]

# v1.13.1

* Using `links` in compose files is now allowed [petrosagg]

# v1.13.0

* Allow the supervisor to work in offline mode [Pablo]
* Fix duplicate logs issue [Kostas]
* **[Breaking]** Do not bind mount /run/dbus to /run/dbus [Pablo]
* Default to not bind mounting kmod if container distro can't be found [Pablo]
* Use log-timestamp to add timestamps to logs [Pablo]

# v1.12.2

* Bind mount kmod if the container is debian or raspbian [Pablo]

# v1.12.1

* Fix preloaded apps by passing appId to extendEnvVars

# v1.12.0

* Add endpoints for docker-compose up and down [Pablo]

# v1.11.6

* Fixed deltas for older docker daemon versions [petrosagg]

# v1.11.5

* Fix entry.sh when DOCKER_ROOT isn't set [Page]

# v1.11.4

* Cleanup docker images if delta failed [petrosagg]
* Make the data path configurable [Pablo]

# v1.11.3

* Add listener for container events and reattach on restart [Pablo]
* fix deltas by not using the supervisor as source [Pablo]

# v1.11.2

* fix delta error handling by listening for the 'error' event [petrosagg]

# v1.11.1

* Use sh for postinstall as alpine has no bash [Pablo]
* update docker-delta to 0.0.8 [petrosagg]
* symlink docker root to default path if not already there [petrosagg]

# v1.11.0

* Add restart policies and change default to auto-restart [Aleksis]

# v1.10.1

* Switch to docker-delta library to use deltas v2 [petrosagg]
* Correctly compare container image name on cleanup [Pablo]
* Log useful supervisor info to stdout/stderr [Kostas]

# v1.10.0

* Fix progress bars on docker version 1.10 [Aleksis]

# v1.9.0

* Fix reporting of supervisor version for alpine supervisor [Pablo]
* Use rwlock to block when pulling images [Pablo]
* Increase API timeout to 15 minutes, and make it configurable [Pablo]
* Add endpoint to load images from a docker save tar [Pablo]
* Add alpine supervisor build information [Trong]
* Add endpoints to manage images and containers locally [Pablo]
* Only use bodyParser for endpoints that need it [Pablo]
* Add RESIN_APP_ID variable [Pablo]
* Increase delta request timeout to 15 minutes [Pablo]

# v1.8.0

* Add endpoints to start, stop and get app [Pablo, Kostas]
* Removed a bunch ofobsolete code for the old terminal, reducing the supervisor size considerably. [Page]

# v1.7.0

* Add RESIN_HOST_LOG_TO_DISPLAY variable [Pablo]
* Add system logs for special actions and host config [Pablo]
* Fix setting config.txt for RPi 3 [Pablo]
* Fix saving config vars to DB before reboot [Pablo]
* Bind mount host /var/lib/connman to application /host_var/lib/connman [Aleksis]
* Add RESIN_SUPERVISOR_DELTA to special list so that app is not restarted when it changes [Pablo]

# v1.6.1

* Reduce noise in logs [Kostas]

# v1.6.0

* Add endpoint to get device state [Pablo]
* Check for valid strings or ints in all config values [Pablo]
* Remove quotes in OS version [Pablo]

# v1.5.0

* Add support for delta image download [petrosagg and Pablo]

# v1.4.0

* Report Host OS version to the API [Pablo]
* Use _.defaults instead of _.extend to ensure internal env vars are not overwritten [Pablo]
* Expose resin API key to apps [Pablo]
* On download start, set download_progress to 0. On finish, set state to Idle [Pablo]
* Set GOARM separately for each architecture [Pablo]
* Add armv5 (armel) build [Trong]
* Add OOM protection for the supervisor container, openvpn and connmand [Praneeth]

# v1.3.2

* Do not report the tun addresses to API [Praneeth]

# v1.3.1

* Only save the app if starting the container was successful [Pablo]

# v1.3.0

* Remove volumes when removing a container [Pablo]
* Refactor the still undocumented special env vars into RESIN_SUPERVISOR_ [Pablo]
* Implement several update strategies (kill before download, 0-downtime) [Pablo]
* Fix the error that comes up when no ip addresses are returned by gosuper [Praneeth]
* Switched to docker-progress for pull progress. [Page]
* Fix semver versioning in tcp-ping endpoint. [Praneeth]

# v1.2.1

* Use random name for PubNub channel and report to API [Pablo]

# v1.2.0

* Don't bind mount (the sometimes non-existent) docker.sock [Pablo]
* Expose a RESIN_SUPERVISOR_VERSION env var to app [Pablo]

# v1.1.1

* Prevent non-fatal errors from causing the supervisor to exit [Lorenzo]
* Use buildtime env vars as the default Pubnub and Mixpanel keys [Pablo]

# v1.1.0

* Switch back to using arch-based node images [Pablo]
* Don't allow bootstrap to delete apiSecret from DB [Pablo]
* Add API endpoint to expire and create new API key [Pablo]
* Enable control of API poll interval through Device Variables [Praneeth]
* Allow control of VPN + TCP check + Pub nub logs with Device Environment variables [Praneeth]
* Add GO api for openvpn control [Praneeth]

# v1.0.2

* Fix getting API key from DB by returning its .value [Pablo]

# v1.0.1

* Pass supervisor API key to app, don't regenerate the key, and authenticate ALL requests [Pablo]
* Use raspberrypi2 base image for armv7hf [Pablo]
* Bugfix: wrap all errors from update as Error objects - prevents image cleanup on download failures [Pablo]
* Wait 10 seconds after sending SIGTERM and before sending SIGKILL when stopping a container [petrosagg]

# v1.0.0

* Expose supervisor API to app by allowing all requests from 127.0.0.1 and passing address and port as env vars [Pablo]
* Only apply special actions / boot config on change, and always persist to DB [Pablo]

# v0.0.18

* Fix preloaded apps so that they have the complete environment [Pablo]

# v0.0.17

* Updated bases image to board-specific, and all node versions to 0.10.40-slim [Pablo]
* Allow changing RPi config.txt with environment variables [Pablo]
* Allow special env vars with a callback which don't cause an app restart [Pablo and Praneeth]
* Remove unused config.supervisorContainer in config.coffee [Praneeth]
* Implement and use golang endpoint for getting IPs of the device, also fixes duplicate IP reporting in the JS implementation [Praneeth]
* Refactor bootstrapping to run in background [Pablo]
* Run preloaded app images [Pablo]
* Add API endpoints for device reboot and shutdown [Pablo]
* Add /restart endpoint to restart container [Pablo]
* Add additional mount point for the host dbus on host_run/dbus [Praneeth]
* Switch to golang 1.5.1 for compiling [Praneeth]
* Allow /purge to be called with appId as string or number [Pablo]
* Fetch containerId from DB within lock [Pablo]
* Change update cycle to map by appId [Pablo]
* Allow updates to be forced via an env var or an API call [Pablo]
* Use lockfile to lock updates per app [Pablo]

# v0.0.16

* Disabled the TCP ping whilst the VPN is connected. [Praneeth]
* Added TCP ping enable/disable endpoints. [Praneeth]
* Added initial go supervisor, using it to purge the /data directory of apps. [Pablo]
* Mounted /lib/firmware into the user container. [Pablo]
* Fixed spaces in env vars for web terminal. [Petros]
* Added missing return when no app id specified. [Pablo]
* Try to populate the docker cache before building. [Page]

# v0.0.15

* Make resolv.conf writable from a user container. [Praneeth]
* Updated pubnub (3.7.13 doesn't seem to have the heartbeat unnecessarily)
* Fixed an issue where an image would not be cleaned up if it was tagged in multiple repos. [Page]
* Use JOBS=MAX for npm install. [Page]
* Updated pinejs-client so that valid ssl certificates are enforced by default. [Page]
* Write the `registered_at` time to config.json as well, in case there is a failure between writing to config.json and writing to knex [Page]

# v0.0.14

* Clean up tmp files left behind by npm [Page]
* Fix an error where mixpanel events would have the wrong uuid set on first provision. [Page]
* Update knexjs to ~0.8.3, which uses lodash 3 and means it will be deduplicated (reducing image size and runtime memory usage) [Page]
* Stop caching config.json, avoids a race that could cause getting stuck repeatedly trying to register [Page]

# v0.0.13

* Bind mount /etc/resolv.conf as ro for application containers and supervisor [Praneeth]

# v0.0.12

* Stopped displaying an error message when trying to start a container that is already started.
* Improved error messages reported to the user in the case of finding an empty string.
* Switched to using the dockerode pull progress mechanism.
* Fixed trying to delete supervisor container when it reports an alternate tag instead of the primary tag.
* Switched to using the i386-node image as a base for the i386-supervisor
* Fixed reporting error objects to mixpanel.
