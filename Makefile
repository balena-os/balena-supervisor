# balena-supervisor Makefile
#
# If you're looking for an easy way to develop on the supervisor, check ./tools/dev/dindctl, which provides a simplified interface
# to this makefile.
#
# Build targets (require Docker 17.05 or greater):
# * supervisor (default) - builds a balena-supervisor image
# * deploy - pushes a balena-supervisor image to the registry, retrying up to 3 times
# * nodedeps, nodebuild - builds the node component, with the node_modules and src at /usr/src/app and /build (also includes a rootfs-overlay there)
# * supervisor-dind: build the development docker-in-docker supervisor that run-supervisor uses (requires a SUPERVISOR_IMAGE to be available locally)
#
# Variables for build targets:
# * ARCH: amd64/rpi/i386/armv7hf/armel/aarch64 architecture for which to build the supervisor - default: amd64
# * IMAGE: image to build or deploy - default: balena/$(ARCH)-supervisor:latest
# * MIXPANEL_TOKEN: (optional) default mixpanel key to embed in the supervisor image
# * DISABLE_CACHE: if set to true, run build with no cache - default: false
# * DOCKER_BUILD_OPTIONS: Additional options for docker build, like --cache-from parameters
#
# Test/development targets:
# * run-supervisor, stop-supervisor - build and start or stop a docker-in-docker balena-supervisor (requires aufs, ability to run privileged containers, and a SUPERVISOR_IMAGE to be available locally)
#
# Variables for test/dev targets:
# * IMAGE: image to build and run (either for run-supervisor or test-gosuper/integration)
# * SUPERVISOR_IMAGE: In run-supervisor and supervisor-dind, the supervisor image to run inside the docker-in-docker image
# * PRELOADED_IMAGE: If true, will preload user app image from tools/dev/apps.json and bind mount apps.json into the docker-in-docker supervisor
# * MOUNT_DIST: If true, mount the dist folder into the docker-in-docker supervisor
# * MOUNT_NODE_MODULES: If true, mount the node_modules folder into the docker-in-docker supervisor
# * CONTAINER_NAME: For run-supervisor, specify the container name for the docker-in-docker container (default: supervisor which produces container balena-container-supervisor)
# * CONFIG_FILENAME: For run-supervisor, specify the filename to mount as config.json, relative to tools/dind/ (default: config.json)
# * DIND_IMAGE: For run-supervisor, specify the balenaOS image to use (default: resin/resinos:2.12.5_rev1-intel-nuc)
#

# Based on https://stackoverflow.com/a/8540718/2549019
# Retrieves a repo part of the given docker image string
# Param:
#   1. String to parse in form 'repo[:tag]'.
repo = $(firstword $(subst :, ,$1))

# Returns a tag (if any) on a docker image string.
# If there is no tag part in the string, returns latest
# Param:
#   1. String to parse in form 'repo[:tag]'.
tag = $(or $(word 2,$(subst :, ,$1)),latest)

THIS_FILE := $(lastword $(MAKEFILE_LIST))

help:
	@cat $(THIS_FILE) | awk '{if(/^#/)print;else exit}' | sed 's/\#//'

OS := $(shell uname)

# If we're behind a proxy, use it during build
ifdef http_proxy
	DOCKER_HTTP_PROXY=--build-arg http_proxy=$(http_proxy)
endif

ifdef https_proxy
	DOCKER_HTTPS_PROXY=--build-arg https_proxy=$(https_proxy)
endif

ifdef no_proxy
	DOCKER_NO_PROXY=--build-arg no_proxy=$(no_proxy)
endif

DISABLE_CACHE ?= 'false'

DOCKER_VERSION:=$(shell docker version --format '{{.Server.Version}}')
DOCKER_MAJOR_VERSION:=$(word 1, $(subst ., ,$(DOCKER_VERSION)))
DOCKER_MINOR_VERSION:=$(word 2, $(subst ., ,$(DOCKER_VERSION)))
DOCKER_GE_17_05 := $(shell [ $(DOCKER_MAJOR_VERSION) -gt 17 -o \( $(DOCKER_MAJOR_VERSION) -eq 17 -a $(DOCKER_MINOR_VERSION) -ge 5 \) ] && echo true)

# Default values for Mixpanel key
MIXPANEL_TOKEN ?= bananasbananas

# Default architecture and output image
ARCH ?= amd64
IMAGE ?= balena/$(ARCH)-supervisor:master

# Default values for run-supervisor
SUPERVISOR_IMAGE ?= balena/$(ARCH)-supervisor:master
CONTAINER_NAME ?= supervisor
CONFIG_FILENAME ?= config.json
DIND_IMAGE ?= resin/resinos:2.12.5_rev1-intel-nuc

# Bind mounts and variables for the run-supervisor target
SUPERVISOR_DIND_MOUNTS := -v $$(pwd)/config/supervisor-image.tar:/usr/src/supervisor-image.tar:ro
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/start-resin-supervisor:/usr/bin/start-resin-supervisor:ro
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/config/supervisor.conf:/etc/resin-supervisor/supervisor.conf

# required
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v /dev/null:/usr/lib/sysctl.d/balena-os-sysctl.conf
# definitely work
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/etc/systemd/system/rngd.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/etc/systemd/system/systemd-udevd.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/true:/usr/lib/balena/balena-healthcheck
# probably work
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/chronyd.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/etc/systemd/system/chronyd.service.d/chronyd.conf
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/os-udevrules.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/ModemManager.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/NetworkManager.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/avahi-daemon.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/etc/systemd/system/avahi-daemon.service.d/avahi-daemon.conf
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/true:/usr/lib/resin-supervisor/resin-supervisor-healthcheck
# maybe works
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/systemd-udev-settle.service
SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/fake.service:/lib/systemd/system/systemd-udev-trigger.service

ifeq ($(PRELOADED_IMAGE),true)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/apps.json:/mnt/data/apps.json
else
	PRELOADED_IMAGE=
endif

ifeq ($(MOUNT_DIST), true)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/../../dist:/resin-supervisor/dist
endif

ifeq ($(MOUNT_NODE_MODULES), true)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/../../node_modules:/resin-supervisor/node_modules
endif

ifeq ($(MOUNT_BACKUP), true)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/backup.tgz:/mnt/data/backup.tgz.mounted
endif

ifdef TARGET_COMPONENT
	DOCKER_TARGET_COMPONENT := "--target=${TARGET_COMPONENT}"
else
	DOCKER_TARGET_COMPONENT :=
endif

# Default target is to build the supervisor image
all: supervisor

supervisor-tar:
	cd tools/dind \
	&& mkdir -p config
	# TODO: Need to change this to only happen once for a given image so spinning up
	# multiple dind supervisors doesn't hammer the disk as much
	# && docker save --output config/supervisor-image.tar $(SUPERVISOR_IMAGE)

supervisor-conf:
	cd tools/dind \
	&& mkdir -p config \
	&& echo "SUPERVISOR_IMAGE=$(call repo,$(SUPERVISOR_IMAGE))" > config/supervisor.conf \
	&& echo "SUPERVISOR_TAG=$(call tag,$(SUPERVISOR_IMAGE))" >> config/supervisor.conf \
	&& echo "LED_FILE=/dev/null" >> config/supervisor.conf

supervisor-dind: supervisor-tar supervisor-conf

run-supervisor: supervisor-dind
	cd tools/dind \
	&& ./balenaos-in-container/balenaos-in-container.sh \
		--detach \
		--config "$(CONFIG_FILENAME)" \
		--image $(DIND_IMAGE) \
		--id $(CONTAINER_NAME) \
		--extra-args "${SUPERVISOR_DIND_MOUNTS}"

stop-supervisor:
	-docker stop balena-container-$(CONTAINER_NAME) > /dev/null || true
	# TODO: Don't remove volumes for dind supervisors by default since recreating and reloading
	# the supervisor image every time is slow
	# -docker rm -f --volumes balena-container-$(CONTAINER_NAME) > /dev/null || true

supervisor-image:
ifneq ($(DOCKER_GE_17_05),true)
	@echo "Docker >= 17.05 is needed to build the supervisor"
	@exit 1
endif
	docker build \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		$(DOCKER_TARGET_COMPONENT) \
		$(DOCKER_BUILD_OPTIONS) \
		--no-cache=$(DISABLE_CACHE) \
		--build-arg ARCH=$(ARCH) \
		--build-arg VERSION=$(shell jq -r .version package.json) \
		--build-arg DEFAULT_MIXPANEL_TOKEN=$(MIXPANEL_TOKEN) \
		`if [ -n "$$DEBUG" ]; then echo '-f Dockerfile.debug'; fi` \
		-t $(IMAGE) .

supervisor:
	@$(MAKE) -f $(THIS_FILE) IMAGE=$(IMAGE) ARCH=$(ARCH) supervisor-image

deploy:
	@bash retry_docker_push.sh $(IMAGE)

nodedeps:
	$(MAKE) -f $(THIS_FILE) TARGET_COMPONENT=node-deps IMAGE=$(IMAGE) ARCH=$(ARCH) supervisor-image

nodebuild:
	$(MAKE) -f $(THIS_FILE) TARGET_COMPONENT=node-build IMAGE=$(IMAGE) ARCH=$(ARCH) supervisor-image

.PHONY: supervisor deploy nodedeps nodebuild supervisor-dind run-supervisor
