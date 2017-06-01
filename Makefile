OS := $(shell uname)

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

DISABLE_CACHE = 'false'

ARCH = rpi# rpi/amd64/i386/armv7hf/armel/aarch64

DEPLOY_REGISTRY =

SUPERVISOR_VERSION = master
BASE_IMAGE_VERSION = $(shell find base-image -print0 | LC_ALL=C sort -z | tar --null -cf - --no-recursion --mtime=@0 --owner=root --group=root --numeric-owner -T - | md5sum | awk -F " " '{print $$1}')
ESCAPED_BASE_IMAGE_TAG = resin\/$(ARCH)-supervisor-base:$(BASE_IMAGE_VERSION)

DOCKER_VERSION:=$(shell docker version --format '{{.Server.Version}}')
DOCKER_MAJOR_VERSION:=$(word 1, $(subst ., ,$(DOCKER_VERSION)))
DOCKER_MINOR_VERSION:=$(word 2, $(subst ., ,$(DOCKER_VERSION)))
DOCKER_GE_1_12 := $(shell [ $(DOCKER_MAJOR_VERSION) -gt 1 -o \( $(DOCKER_MAJOR_VERSION) -eq 1 -a $(DOCKER_MINOR_VERSION) -ge 12 \) ] && echo true)

# In docker 1.12 tag --force has been removed.
ifeq ($(DOCKER_GE_1_12),true)
DOCKER_TAG_FORCE=
else
DOCKER_TAG_FORCE=-f
endif

all: supervisor

PUBNUB_SUBSCRIBE_KEY = sub-c-bananas
PUBNUB_PUBLISH_KEY = pub-c-bananas
MIXPANEL_TOKEN = bananasbananas

PASSWORDLESS_DROPBEAR = false

IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"
DOCKERFILE = $(ARCH)

SUPERVISOR_IMAGE=$(DEPLOY_REGISTRY)$(IMAGE)

ifeq ($(ARCH),rpi)
	GOARCH = arm
	GOARM = 6
endif
ifeq ($(ARCH),armv7hf)
	GOARCH = arm
	GOARM = 7
endif
ifeq ($(ARCH),armel)
	GOARCH = arm
	GOARM = 5
endif
ifeq ($(ARCH),i386)
	GOARCH = 386
endif
ifeq ($(ARCH),amd64)
	GOARCH = amd64
endif
ifeq ($(ARCH),aarch64)
	GOARCH = arm64
endif
SUPERVISOR_DIND_MOUNTS := -v $$(pwd)/../../:/resin-supervisor -v $$(pwd)/config.json:/mnt/conf/config.json -v $$(pwd)/config/env:/usr/src/app/config/env -v $$(pwd)/config/localenv:/usr/src/app/config/localenv
ifeq ($(OS), Linux)
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v /sys/fs/cgroup:/sys/fs/cgroup:ro -v /bin/kmod:/bin/kmod
endif
ifdef PRELOADED_IMAGE
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/apps.json:/usr/src/app/config/apps.json
else
	PRELOADED_IMAGE=
endif

SUPERVISOR_EXTRA_MOUNTS =

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

supervisor-dind: ${DOCKERD_PROXY}
	cd tools/dind \
	&& docker build \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		--no-cache=$(DISABLE_CACHE) \
		--build-arg PASSWORDLESS_DROPBEAR=$(PASSWORDLESS_DROPBEAR) \
		-t resin/resin-supervisor-dind:$(SUPERVISOR_VERSION) .

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
	&& docker run -d --name resin_supervisor_1 --privileged ${SUPERVISOR_DIND_MOUNTS} resin/resin-supervisor-dind:$(SUPERVISOR_VERSION)

stop-supervisor:
	# Stop docker and remove volumes to prevent us from running out of loopback devices,
	# as per https://github.com/jpetazzo/dind/issues/19
	-docker exec resin_supervisor_1 bash -c "systemctl stop docker" || true
	-docker stop resin_supervisor_1 > /dev/null || true
	-docker rm -f --volumes resin_supervisor_1 > /dev/null || true

refresh-supervisor-src:
	echo " * Compiling CoffeeScript.." \
	&& coffee -c ./src \
	&& echo " * Restarting supervisor container.." \
	&& docker exec -ti resin_supervisor_1 docker restart resin_supervisor

supervisor: nodesuper gosuper
	sed 's/%%ARCH%%/$(ARCH)/g' Dockerfile.runtime.template | sed 's/%%BASE_IMAGE_TAG%%/$(ESCAPED_BASE_IMAGE_TAG)/g' > Dockerfile.runtime.$(ARCH)
	echo "ENV VERSION=$(shell jq -r .version package.json) \\" >> Dockerfile.runtime.$(ARCH)
	echo "    DEFAULT_PUBNUB_PUBLISH_KEY=$(PUBNUB_PUBLISH_KEY) \\" >> Dockerfile.runtime.$(ARCH)
	echo "    DEFAULT_PUBNUB_SUBSCRIBE_KEY=$(PUBNUB_SUBSCRIBE_KEY) \\" >> Dockerfile.runtime.$(ARCH)
	echo "    DEFAULT_MIXPANEL_TOKEN=$(MIXPANEL_TOKEN)" >> Dockerfile.runtime.$(ARCH)
ifdef rt_https_proxy
	echo "ENV HTTPS_PROXY=$(rt_https_proxy) \\" >> Dockerfile.runtime.$(ARCH)
	echo "    https_proxy=$(rt_https_proxy)" >> Dockerfile.runtime.$(ARCH)
endif
ifdef rt_http_proxy
	echo "ENV HTTP_PROXY=$(rt_http_proxy) \\" >> Dockerfile.runtime.$(ARCH)
	echo "    http_proxy=$(rt_http_proxy)" >> Dockerfile.runtime.$(ARCH)
endif
ifdef rt_no_proxy
	echo "ENV no_proxy=$(rt_no_proxy)" >> Dockerfile.runtime.$(ARCH)
endif
	docker build \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		-f Dockerfile.runtime.$(ARCH) \
		--pull \
		-t $(IMAGE) .

lint:
	docker run --rm resin/node-supervisor-$(ARCH):$(SUPERVISOR_VERSION) bash -c 'npm install resin-lint && npm run lint'

deploy: supervisor
	docker tag $(DOCKER_TAG_FORCE) $(IMAGE) $(SUPERVISOR_IMAGE)
	bash retry_docker_push.sh $(SUPERVISOR_IMAGE)

nodesuper:
	sed 's/%%ARCH%%/$(ARCH)/g' Dockerfile.build.template > Dockerfile.build.$(ARCH)
	docker build --pull \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		-f Dockerfile.build.$(ARCH) \
		-t resin/node-supervisor-$(ARCH):$(SUPERVISOR_VERSION) .
	docker run --rm \
		-v `pwd`/build/$(ARCH):/build \
		resin/node-supervisor-$(ARCH):$(SUPERVISOR_VERSION)

gosuper:
	cd gosuper && docker build --pull \
		$(DOCKER_HTTP_PROXY) \
		$(DOCKER_HTTPS_PROXY) \
		$(DOCKER_NO_PROXY) \
		--build-arg GOARCH=$(GOARCH) \
		--build-arg GOARM=$(GOARM) \
		-t resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) .
	docker run --rm \
		-v `pwd`/build/$(ARCH):/build \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION)

test-gosuper: gosuper
	docker run \
		--rm \
		-v /var/run/dbus:/mnt/root/run/dbus \
		-e DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket" \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) bash -c \
			'./test_formatting.sh && go test -v ./gosuper'

format-gosuper: gosuper
	docker run \
		--rm \
		-v $(shell pwd)/gosuper:/go/src/resin-supervisor/gosuper \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) \
			go fmt ./...

test-integration: gosuper
	docker run \
		--rm \
		--net=host \
		-e SUPERVISOR_IP="$(shell docker inspect --format '{{ .NetworkSettings.IPAddress }}' resin_supervisor_1)" \
		--volumes-from resin_supervisor_1 \
		-v /var/run/dbus:/mnt/root/run/dbus \
		-e DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket" \
		resin/go-supervisor-$(ARCH):$(SUPERVISOR_VERSION) \
			go test -v ./supertest

base-image-version:
	@echo $(BASE_IMAGE_VERSION)

.PHONY: supervisor deploy supervisor-dind run-supervisor gosuper nodesuper
