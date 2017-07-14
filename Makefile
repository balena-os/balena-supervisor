# resin-supervisor Makefile
#
# If you're looking for an easy way to develop on the supervisor, check ./tools/dev/dindctl, which provides a simplified interface
# to this makefile.
#
# Build targets (require Docker 17.05 or greater):
# * supervisor (default) - builds a resin-supervisor image
# * deploy - pushes a resin-supervisor image to the registry, retrying up to 3 times
# * base - builds the "base" component (a yocto builder with the output rootfs at /dest)
# * gosuper - builds the "gosuper" component (a golang image with the Go supervisor component at /go/bin/gosuper and /build/gosuper)
# * nodesuper - builds the node component, with the node_modules and src at /usr/src/app and /build (also includes a rootfs-overlay there)
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
# * format-gosuper, test-gosuper - build a gosuper image and run formatting or unit tests
# * test-integration - run an integration test (see gosuper/supertest). Requires a docker-in-docker supervisor to be running
#
# Variables for test/dev targets:
# * IMAGE: image to build and run (either for run-supervisor or test-gosuper/integration)
# * SUPERVISOR_IMAGE: In run-supervisor and supervisor-dind, the supervisor image to run inside the docker-in-docker image
# * PRELOADED_IMAGE: If true, will preload user app image from tools/dev/apps.json and bind mount apps.json into the docker-in-docker supervisor
# * SUPERVISOR_EXTRA_MOUNTS: Additional bind mount flags for the docker-in-docker supervisor
# * PASSWORDLESS_DROPBEAR: For run-supervisor - start a passwordless ssh daemon in the docker-in-docker supervisor
#

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

ifdef use_proxy_at_runtime
	rt_http_proxy=$(http_proxy)
	rt_https_proxy=$(https_proxy)
	rt_no_proxy=$(no_proxy)
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
PASSWORDLESS_DROPBEAR ?= false

# Bind mounts and variables for the run-supervisor target
SUPERVISOR_DIND_MOUNTS := -v $$(pwd)/../../:/resin-supervisor -v $$(pwd)/config.json:/mnt/conf/config.json -v $$(pwd)/config/env:/usr/src/app/config/env -v $$(pwd)/config/localenv:/usr/src/app/config/localenv
ifeq ($(OS), Linux)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v /sys/fs/cgroup:/sys/fs/cgroup:ro -v /bin/kmod:/bin/kmod
endif
ifeq ($(PRELOADED_IMAGE),true)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/apps.json:/usr/src/app/config/apps.json
else
	PRELOADED_IMAGE=
endif
SUPERVISOR_EXTRA_MOUNTS ?=

ifdef TARGET_COMPONENT
	DOCKER_TARGET_COMPONENT := "--target=${TARGET_COMPONENT}"
else
	DOCKER_TARGET_COMPONENT :=
endif

# Default target is to build the supervisor image
all: supervisor

# Settings to make the run-supervisor target work behind a proxy
DOCKERD_PROXY=tools/dind/config/services/docker.service.d/proxy.conf
${DOCKERD_PROXY}:
	rm -f ${DOCKERD_PROXY}
	if [ -n "${rt_http_proxy}" ]; then \
		proxies="\"HTTP_PROXY=${rt_http_proxy}\""; \
		proxies="$${proxies[*]} \"http_proxy=${rt_http_proxy}\""; \
	fi; \
	if [ -n "${rt_https_proxy}" ]; then \
		proxies="$${proxies[*]} \"HTTPS_PROXY=${rt_https_proxy}\""; \
		proxies="$${proxies[*]} \"https_proxy=${rt_https_proxy}\""; \
	fi; \
	if [ -n "${rt_no_proxy}" ]; then \
		proxies="$${proxies[*]} \"no_proxy=${rt_no_proxy}\""; \
	fi; \
	if [ -n "${proxies}" ]; then \
		echo "[Service]" > ${DOCKERD_PROXY}; \
		echo "Environment=$${proxies[*]}" >> ${DOCKERD_PROXY}; \
	else \
		touch ${DOCKERD_PROXY}; \
	fi

supervisor-tar:
	docker save --output tools/dind/supervisor-image.tar $(SUPERVISOR_IMAGE)

supervisor-dind: ${DOCKERD_PROXY} supervisor-tar
	cd tools/dind \
	&& docker build \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		${DOCKER_BUILD_OPTIONS} \
		--no-cache=$(DISABLE_CACHE) \
		--build-arg PASSWORDLESS_DROPBEAR=$(PASSWORDLESS_DROPBEAR) \
		-t $(IMAGE) .

run-supervisor: stop-supervisor supervisor-dind
	cd tools/dind \
	&& echo "SUPERVISOR_IMAGE=$(SUPERVISOR_IMAGE)" > config/localenv \
	&& echo "PRELOADED_IMAGE=$(PRELOADED_IMAGE)" >> config/localenv \
	&& echo "SUPERVISOR_EXTRA_MOUNTS=$(SUPERVISOR_EXTRA_MOUNTS)" >> config/localenv; \
	if [ -n "$(rt_http_proxy)" ]; then \
		echo "HTTP_PROXY=$(rt_http_proxy)" >> config/localenv \
		&& echo "http_proxy=$(rt_http_proxy)" >> config/localenv; \
	fi; \
	if [ -n "$(rt_https_proxy)" ]; then \
		echo "HTTPS_PROXY=$(rt_https_proxy)" >> config/localenv \
		&& echo "https_proxy=$(rt_https_proxy)" >> config/localenv; \
	fi; \
	if [ -n "$(rt_no_proxy)" ]; then \
		echo "no_proxy=$(rt_no_proxy)" >> config/localenv; \
	fi \
	&& docker run -d --name resin_supervisor_1 --privileged ${SUPERVISOR_DIND_MOUNTS} $(IMAGE)

stop-supervisor:
	# Stop docker and remove volumes to prevent us from running out of loopback devices,
	# as per https://github.com/jpetazzo/dind/issues/19
	-docker exec resin_supervisor_1 bash -c "systemctl stop docker" || true
	-docker stop resin_supervisor_1 > /dev/null || true
	-docker rm -f --volumes resin_supervisor_1 > /dev/null || true

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

base:
	$(MAKE) -f $(THIS_FILE) TARGET_COMPONENT=base IMAGE=$(IMAGE) ARCH=$(ARCH) supervisor-image

nodesuper:
	$(MAKE) -f $(THIS_FILE) TARGET_COMPONENT=node IMAGE=$(IMAGE) ARCH=$(ARCH) supervisor-image

gosuper:
	$(MAKE) -f $(THIS_FILE) TARGET_COMPONENT=gosuper IMAGE=$(IMAGE) ARCH=$(ARCH) supervisor-image

test-gosuper: gosuper
	docker run \
		--rm \
		-v /var/run/dbus:/mnt/root/run/dbus \
		-e DBUS_SYSTEM_BUS_ADDRESS="/mnt/root/run/dbus/system_bus_socket" \
		$(IMAGE) bash -c \
			'./test_formatting.sh && go test -v ./gosuper'

format-gosuper: gosuper
	docker run \
		--rm \
		-v $(shell pwd)/gosuper:/go/src/resin-supervisor/gosuper \
		$(IMAGE) \
			go fmt ./...

test-integration: gosuper
	docker run \
		--rm \
		--net=host \
		-e SUPERVISOR_IP="$(shell docker inspect --format '{{ .NetworkSettings.IPAddress }}' resin_supervisor_1)" \
		--volumes-from resin_supervisor_1 \
		-v /var/run/dbus:/mnt/root/run/dbus \
		-e DBUS_SYSTEM_BUS_ADDRESS="/mnt/root/run/dbus/system_bus_socket" \
		$(IMAGE) \
			go test -v ./supertest

.PHONY: supervisor deploy base nodesuper gosuper supervisor-dind run-supervisor
