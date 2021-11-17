#!/bin/sh

set -o errexit

. ./setenv.sh

# TODO: should we do a pre-start check here? Ideas
# - check that DOCKER_SOCKET is present and that it points to an actual engine socket
# - check that ROOT_MOUNTPOINT exists and the configuration files are present

# If the legacy /tmp/resin-supervisor exists on the host, a container might
# already be using to take an update lock, so we symlink it to the new
# location so that the supervisor can see it
[ -d /mnt/root/tmp/resin-supervisor ] &&
    ( [ -d /mnt/root/tmp/balena-supervisor ] || ln -s ./resin-supervisor /mnt/root/tmp/balena-supervisor )

# Otherwise, if the lockfiles directory doesn't exist
[ -d /mnt/root/tmp/balena-supervisor ] ||
    mkdir -p /mnt/root/tmp/balena-supervisor

# Look for a custom root certificate
BALENA_ROOT_CA_FILE=${ROOT_MOUNTPOINT}/usr/share/ca-certificates/balena/balenaRootCA.crt
if [ -z "${BALENA_ROOT_CA}" ] && [ -f "${BALENA_ROOT_CA_FILE}" ]; then
  BALENA_ROOT_CA=$(cat ${BALENA_ROOT_CA_FILE})
  export NODE_EXTRA_CA_CERTS=${BALENA_ROOT_CA_FILE}
fi

# Include self-signed CAs, should they exist
if [ -n "${BALENA_ROOT_CA}" ]; then
	if [ ! -e '/etc/ssl/certs/balenaRootCA.pem' ]; then
		echo "${BALENA_ROOT_CA}" > /etc/ssl/certs/balenaRootCA.pem

		# Include the balenaRootCA in the system store for services like Docker
		mkdir -p /usr/local/share/ca-certificates
		echo "${BALENA_ROOT_CA}" > /usr/local/share/ca-certificates/balenaRootCA.crt
		update-ca-certificates

		export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/balenaRootCA.crt
	fi
fi

# Mount the host kernel module path onto the expected location
# We need to do this as busybox doesn't support using a custom location
if [ ! -d /lib/modules ]; then
	ln -s /mnt/root/lib/modules /lib/modules
fi
# Now load the ip6_tables kernel module, so we can do
# filtering on ipv6 addresses. Don't fail here if the
# modprobe fails, as this can either be that the module is
# already loaded or that the kernel module isn't present. In
# the former case, this is fine for runtime, and in the
# latter it means that the supervisor will fail later on, so
# not a problem.
modprobe ip6_tables || true


if [ "${LIVEPUSH}" = "1" ]; then
	exec npx nodemon --watch src --watch typings --ignore tests -e js,ts,json \
		 --exec node -r ts-node/register/transpile-only src/app.ts
else
	exec node /usr/src/app/dist/app.js
fi
