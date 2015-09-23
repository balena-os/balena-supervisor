DISABLE_CACHE = 'false'

ARCH = rpi# rpi/amd64/i386/armv7hf

DEPLOY_REGISTRY =

SUPERVISOR_VERSION = master
JOB_NAME = 1

all: supervisor

IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"
SUPERVISOR_IMAGE=$(DEPLOY_REGISTRY)$(IMAGE)

PUBNUB_SUBSCRIBE_KEY = sub-c-bananas
PUBNUB_PUBLISH_KEY = pub-c-bananas
MIXPANEL_TOKEN = bananasbananas

ifeq ($(ARCH),rpi)
	GOARCH = arm
endif
ifeq ($(ARCH),armv7hf)
	GOARCH = arm
endif
ifeq ($(ARCH),i386)
	GOARCH = 386
endif
ifeq ($(ARCH),amd64)
	GOARCH = amd64
endif
SUPERVISOR_DIND_MOUNTS := -v $$(pwd)/../../:/resin-supervisor -v $$(pwd)/config.json:/mnt/conf/config.json -v $$(pwd)/config/env:/usr/src/app/config/env -v $$(pwd)/config/localenv:/usr/src/app/config/localenv -v /sys/fs/cgroup:/sys/fs/cgroup:ro
ifdef PRELOADED_IMAGE
	SUPERVISOR_DIND_MOUNTS := ${SUPERVISOR_DIND_MOUNTS} -v $$(pwd)/apps.json:/usr/src/app/config/apps.json
else
	PRELOADED_IMAGE=
endif

clean:
	-rm Dockerfile

supervisor-dind:
	cp 01_nodoc tools/dind/config/
	touch -t 7805200000 tools/dind/config/01_nodoc
	cd tools/dind && docker build --no-cache=$(DISABLE_CACHE) -t resin/resin-supervisor-dind:$(SUPERVISOR_VERSION) .
	rm tools/dind/config/01_nodoc

run-supervisor: supervisor-dind stop-supervisor
	cd tools/dind \
	&& echo "SUPERVISOR_IMAGE=$(SUPERVISOR_IMAGE)\nPRELOADED_IMAGE=$(PRELOADED_IMAGE)" > config/localenv \
	&& docker run -d --name resin_supervisor_1 --privileged ${SUPERVISOR_DIND_MOUNTS} resin/resin-supervisor-dind:$(SUPERVISOR_VERSION)

stop-supervisor:
	# Stop docker and remove volumes to prevent us from running out of loopback devices,
	# as per https://github.com/jpetazzo/dind/issues/19
	-docker exec resin_supervisor_1 bash -c "systemctl stop docker" || true
	-docker stop resin_supervisor_1 > /dev/null || true
	-docker rm -f --volumes resin_supervisor_1 > /dev/null || true

supervisor: gosuper
	cp Dockerfile.$(ARCH) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	echo "ENV DEFAULT_PUBNUB_PUBLISH_KEY $(PUBNUB_PUBLISH_KEY)" >> Dockerfile
	echo "ENV DEFAULT_PUBNUB_SUBSCRIBE_KEY $(PUBNUB_SUBSCRIBE_KEY)" >> Dockerfile
	echo "ENV DEFAULT_MIXPANEL_TOKEN $(MIXPANEL_TOKEN)" >> Dockerfile
	docker build --no-cache=$(DISABLE_CACHE) -t $(IMAGE) .
	-rm Dockerfile

deploy: supervisor
	docker tag -f $(IMAGE) $(SUPERVISOR_IMAGE)
	bash retry_docker_push.sh $(SUPERVISOR_IMAGE)

go-builder:
	-cp tools/dind/config.json ./gosuper/
	cd gosuper && docker build -t resin/go-supervisor-builder:$(SUPERVISOR_VERSION) .
	-rm ./gosuper/config.json

gosuper: go-builder
	-mkdir -p bin
	-docker rm --volumes -f resin_build_gosuper_$(JOB_NAME) || true
	docker run --name resin_build_gosuper_$(JOB_NAME) -v $(shell pwd)/gosuper/bin:/usr/src/app/bin -e USER_ID=$(shell id -u) -e GROUP_ID=$(shell id -g) -e GOARCH=$(GOARCH) resin/go-supervisor-builder:$(SUPERVISOR_VERSION)
	docker rm --volumes -f resin_build_gosuper_$(JOB_NAME)
	mv gosuper/bin/linux_$(GOARCH)/gosuper bin/gosuper

test-gosuper: go-builder
	-docker rm --volumes -f resin_test_gosuper_$(JOB_NAME) || true
	docker run --name resin_test_gosuper_$(JOB_NAME) -v /var/run/dbus:/mnt/root/run/dbus -e DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket" resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor/gosuper && ./test_formatting.sh && ./test_gosuper.sh"
	docker rm --volumes -f resin_test_gosuper_$(JOB_NAME)

format-gosuper: go-builder
	-docker rm --volumes -f resin_test_gosuper_$(JOB_NAME) || true
	docker run --name resin_test_gosuper_$(JOB_NAME) -v $(shell pwd)/gosuper:/usr/src/app/src/resin-supervisor/gosuper resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor/gosuper && go fmt ./..."
	docker rm --volumes -f resin_test_gosuper_$(JOB_NAME)

test-integration: go-builder
	-docker rm --volumes -f resin_test_integration_$(JOB_NAME) || true
	docker run --name resin_test_integration_$(JOB_NAME) --net=host -e SUPERVISOR_IP="$(shell docker inspect --format '{{ .NetworkSettings.IPAddress }}' resin_supervisor_1)" --volumes-from resin_supervisor_1 -v /var/run/dbus:/mnt/root/run/dbus -e DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket" resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor/gosuper && go test -v ./supertest"
	docker rm --volumes -f resin_test_integration_$(JOB_NAME)

.PHONY: supervisor deploy supervisor-dind run-supervisor
