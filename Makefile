# resin-supervisor Makefile
#
# If you're looking for an easy way to develop on the supervisor, check ./tools/dev/dindctl, which provides a simplified interface
# to this makefile.
#
# Build targets (require Docker 17.05 or greater):
# * supervisor (default) - builds a resin-supervisor image
# * deploy - pushes a resin-supervisor image to the registry, retrying up to 3 times
# * nodedeps, nodebuild - builds the node component, with the node_modules and src at /usr/src/app and /build (also includes a rootfs-overlay there)
# * supervisor-dind: build the development docker-in-docker supervisor that run-supervisor uses (requires a SUPERVISOR_IMAGE to be available locally)
#
# Variables for build targets:
# * ARCH: amd64/rpi/i386/armv7hf/armel/aarch64 architecture for which to build the supervisor - default: amd64
# * IMAGE: image to build or deploy - default: resin/$(ARCH)-supervisor:latest
# * MIXPANEL_TOKEN, PUBNUB_SUBSCRIBE_KEY, PUBNUB_PUBLISH_KEY: (optional) default pubnub and mixpanel keys to embed in the supervisor image
# * DISABLE_CACHE: if set to true, run build with no cache - default: false
# * DOCKER_BUILD_OPTIONS: Additional options for docker build, like --cache-from parameters
#
# Test/development targets:
# * run-supervisor, stop-supervisor - build and start or stop a docker-in-docker resin-supervisor (requires aufs, ability to run privileged containers, and a SUPERVISOR_IMAGE to be available locally)
#
# Variables for test/dev targets:
# * IMAGE: image to build and run (either for run-supervisor or test-gosuper/integration)
# * SUPERVISOR_IMAGE: In run-supervisor and supervisor-dind, the supervisor image to run inside the docker-in-docker image
# * PRELOADED_IMAGE: If true, will preload user app image from tools/dev/apps.json and bind mount apps.json into the docker-in-docker supervisor
# * MOUNT_DIST: If true, mount the dist folder into the docker-in-docker supervisor
# * MOUNT_NODE_MODULES: If true, mount the node_modules folder into the docker-in-docker supervisor
# * CONTAINER_NAME: For run-supervisor, specify the container name for the docker-in-docker container (default: supervisor which produces container resinos-in-container-supervisor)
# * CONFIG_FILENAME: For run-supervisor, specify the filename to mount as config.json, relative to tools/dind/ (default: config.json)
# * DIND_IMAGE: For run-supervisor, specify the resinOS image to use (default: resin/resinos:2.12.5_rev1-intel-nuc)
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

# Default values for Pubnub and Mixpanel keys
PUBNUB_SUBSCRIBE_KEY ?= sub-c-bananas
PUBNUB_PUBLISH_KEY ?= pub-c-bananas
MIXPANEL_TOKEN ?= bananasbananas

# Default architecture and output image
ARCH ?= amd64
IMAGE ?= resin/$(ARCH)-supervisor:master

# Default values for run-supervisor
SUPERVISOR_IMAGE ?= resin/$(ARCH)-supervisor:master
CONTAINER_NAME ?= supervisor
CONFIG_FILENAME ?= config.json
DIND_IMAGE ?= resin/resinos:2.12.5_rev1-intel-nuc

# Bind mounts and variables for the run-supervisor target
SUPERVISOR_DIND_MOUNTS := -v $$(pwd)/config/supervisor-image.tar:/usr/src/supervisor-image.tar:ro -v $$(pwd)/start-resin-supervisor:/usr/bin/start-resin-supervisor:ro -v $$(pwd)/config/supervisor.conf:/etc/resin-supervisor/supervisor.conf

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

ifdef TARGET_COMPONENT
	DOCKER_TARGET_COMPONENT := "--target=${TARGET_COMPONENT}"
else
	DOCKER_TARGET_COMPONENT :=
endif

# Default target is to build the supervisor image
all: supervisor

supervisor-tar:
	cd tools/dind \
	&& mkdir -p config \
	&& docker save --output config/supervisor-image.tar $(SUPERVISOR_IMAGE)

supervisor-conf:
	cd tools/dind \
	&& mkdir -p config \
	&& echo "SUPERVISOR_IMAGE=$(call repo,$(SUPERVISOR_IMAGE))" > config/supervisor.conf \
	&& echo "SUPERVISOR_TAG=$(call tag,$(SUPERVISOR_IMAGE))" >> config/supervisor.conf \
	&& echo "LED_FILE=/dev/null" >> config/supervisor.conf

supervisor-dind: supervisor-tar supervisor-conf

run-supervisor: supervisor-dind
	cd tools/dind \
	&& ./resinos-in-container/resinos-in-container.sh \
		--detach \
		--config "$$(pwd)/$(CONFIG_FILENAME)" \
		--image $(DIND_IMAGE) \
		--id $(CONTAINER_NAME) \
		--extra-args "${SUPERVISOR_DIND_MOUNTS}"

stop-supervisor:
	-docker stop resinos-in-container-$(CONTAINER_NAME) > /dev/null || true
	-docker rm -f --volumes resinos-in-container-$(CONTAINER_NAME) > /dev/null || true

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
		--build-arg DEFAULT_PUBNUB_PUBLISH_KEY=$(PUBNUB_PUBLISH_KEY) \
		--build-arg DEFAULT_PUBNUB_SUBSCRIBE_KEY=$(PUBNUB_SUBSCRIBE_KEY) \
		--build-arg DEFAULT_MIXPANEL_TOKEN=$(MIXPANEL_TOKEN) \
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
