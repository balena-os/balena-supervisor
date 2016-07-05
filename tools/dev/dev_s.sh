#!/bin/bash

set -o errexit
set -o pipefail
# set -o xtrace

DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
SUPERVISOR_BASE_DIR="${DIR}/../.."

ARCH=${ARCH:-"amd64"}
DEPLOY_REGISTRY=${DEPLOY_REGISTRY:-"registry.resindev.io/"}
PASSWORDLESS_DROPBEAR=${PASSWORDLESS_DROPBEAR:-"false"}
SUPERVISOR_EXTRA_MOUNTS=

function showHelp {
	echo
	echo "	This script can be used to facilitate supervisor development. Its core feature is allowing"
	echo "	faster development iterations by bind-mounting the local './src' directly into the running"
	echo "	supervisor container."
	echo
	echo "	Setting the '--mount-nm' flag in either 'bindrun' or 'deploybindrun' action will bind-mount"
	echo "	'./node_modules/' into the running supervisor as well. In this case, it's up to the developer"
	echo "	to make sure that the correct dependencies are installed."
	echo
	echo "	Usage: [environment] $0 action [options]"
	echo
	echo "	Environment Variables:"
	echo "		ARCH [=amd64]"
	echo "		DEPLOY_REGISTRY [=registry.resindev.io/]"
	echo "		PASSWORDLESS_DROPBEAR [=false]"
	echo "	Actions:"
	echo "		deploy				build supervisor image and deploy it to the registry"
	echo "		run [options]			build dind supervisor host container, run it, then pull supervisor container and run it as well"
	echo "		deployrun [options]		run 'deploy' and 'run'"
	echo "		refresh				recompile sources in './src' with 'coffee -c' and restart supervisor container on dind host"
	echo "		stop				stop dind supervisor host container"
	echo "	Options:"
	echo "		--mount-src			bind-mount './src/' from local development environment into supervisor container"
	echo "		--mount-nm			bind-mount './node_modules/' from local development environment into supervisor container"
	echo
}

function deploySupervisor {
	make -C "$SUPERVISOR_BASE_DIR" \
		ARCH="$ARCH" \
		DEPLOY_REGISTRY="$DEPLOY_REGISTRY" \
		PASSWORDLESS_DROPBEAR="$PASSWORDLESS_DROPBEAR" \
		deploy
}

function runDind {
	for arg in "$@"
	do
		case $arg in
			--mount-src)
				coffee -c "$SUPERVISOR_BASE_DIR/src"
				SUPERVISOR_EXTRA_MOUNTS="$SUPERVISOR_EXTRA_MOUNTS -v /resin-supervisor/src:/app/src"
				shift
				;;
			--mount-nm)
				SUPERVISOR_EXTRA_MOUNTS="$SUPERVISOR_EXTRA_MOUNTS -v /resin-supervisor/node_modules:/app/node_modules"
				shift
				;;
			*)
				;;
		esac
	done

	make -C "$SUPERVISOR_BASE_DIR" \
		ARCH="$ARCH" \
		PASSWORDLESS_DROPBEAR="$PASSWORDLESS_DROPBEAR" \
		SUPERVISOR_EXTRA_MOUNTS="$SUPERVISOR_EXTRA_MOUNTS" \
		SUPERVISOR_IMAGE="#{DEPLOY_REGISTRY}resin/${ARCH}-supervisor:master" \
		run-supervisor
}

case $1 in
	deploy)
		deploySupervisor
		;;
	run)
		shift
		runDind "$@"
		;;
	deployrun)
		shift
		deploySupervisor && runDind "$@"
		;;
	refresh)
		echo " * Compiling CoffeeScript.." \
		&& coffee -c "$SUPERVISOR_BASE_DIR/src" \
		&& echo " * Restarting supervisor container.." \
		&& docker exec -ti resin_supervisor_1 docker restart resin_supervisor
		;;
	stop)
		make -C "$SUPERVISOR_BASE_DIR" stop-supervisor
		;;
	*)
		showHelp
esac

