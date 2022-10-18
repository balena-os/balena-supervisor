#!/bin/sh

if [ "${DEVELOPMENT}" = "1" ]; then
	# Use nodemon in development mode
	npx nodemon -w systemd.ts systemd.ts &
	npx nodemon -w login.ts login.ts
else
	# Launch services in separate processes. node-dbus for some
	# reason blocks when trying to register multiple services
	# on the same process
	node systemd.js &
	node login.js
fi
