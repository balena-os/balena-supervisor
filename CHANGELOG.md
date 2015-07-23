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
