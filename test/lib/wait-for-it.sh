#!/bin/sh

set -e

timeout=30
while :; do
	case $1 in
	-s | --supervisor)
		with_supervisor=1
		shift
		;;
	-t | --timeout) # Takes an option argument, ensuring it has been specified.
		if [ -n "$2" ]; then
			timeout=$2
			shift
		else
			printf 'ERROR: "--timeout" requires a non-empty option argument.\n' >&2
			exit 1
		fi
		shift
		break
		;;
	--) # End of all options.
		shift
		break
		;;
	-?*)
		printf 'WARN: Unknown option (ignored): %s\n' "$1" >&2
		shift
		;;
	*) # Default case: If no more options then break out of the loop.
		break ;;
	esac

	shift
done

cmd="$*"

# Use a local socket for docker by default
DOCKER_HOST="${DOCKER_HOST:-'unix:///var/run/docker.sock'}"

path=${DOCKER_HOST#*//}
host=${path%%/*}
proto=${DOCKER_HOST%:*}

# Install curl
apk add --update curl

docker_healthy() {
	if [ "${proto}" = "unix" ]; then
		curl -s -S --unix-socket "${path}" "http://localhost/_ping"
	else
		curl -s -S "http://${host}/_ping"
	fi
}

dbus_healthy() {
	# The dbus service creates a fake openvpn unit, if the query below
	# succeeds, then the service is ready
	dbus-send --system \
		--print-reply \
		--type=method_call \
		--dest=org.freedesktop.systemd1 \
		/org/freedesktop/systemd1 \
		org.freedesktop.systemd1.Manager.GetUnit string:openvpn.service
}

set_abort_timer() {
	sleep "$1"
	# Send a USR2 signal to the given pid after the timeout happens
	kill -USR2 "$2"
}

# Flag indicating whether the required services are ready
ready=0
abort_if_not_ready() {
	# If the timeout is reached and the required services are not ready, it probably
	# means something went wrong so we terminate the program with an error
	if [ "${ready}" = "0" ]; then
		echo "Something happened, failed to start in ${timeout}s" >&2
		exit 1
	fi
}

# Trap the signal and start the timer if user timeout is greater than 0
if [ "$timeout" -gt 0 ]; then
	trap 'abort_if_not_ready' USR2
	set_abort_timer "$timeout" $$ &
fi

# Wait for docker
until docker_healthy; do
	echo "Waiting for docker at ${DOCKER_HOST}"
	sleep 1
done

# Wait for dbus
until dbus_healthy >/dev/null; do
	echo "Waiting for dbus"
	sleep 1
done

# Wait for supervisor if user requested
BALENA_SUPERVISOR_ADDRESS="${BALENA_SUPERVISOR_ADDRESS:-'http://balena-supervisor:48484'}"
if [ "${with_supervisor}" = "1" ]; then
	until curl -s -f "${BALENA_SUPERVISOR_ADDRESS}/v1/healthy" >/dev/null; do
		echo "Waiting for supervisor at ${BALENA_SUPERVISOR_ADDRESS}"
		sleep 1
	done
fi

# Ignore signal if received
ready=1

exec ${cmd}
