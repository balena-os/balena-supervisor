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
