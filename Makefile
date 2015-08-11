DISABLE_CACHE = 'false'

ARCH = rpi# rpi/amd64/i386/armv7hf

DEPLOY_REGISTRY = registry.resindev.io/

SUPERVISOR_VERSION = master
JOB_NAME = 1

all: supervisor 

IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"

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

clean:
	-rm Dockerfile

supervisor-dind:
	cd tools/dind && docker build --no-cache=$(DISABLE_CACHE) -t resin/resin-supervisor-dind:$(SUPERVISOR_VERSION) .

run-supervisor: supervisor-dind stop-supervisor
	cd tools/dind \
	&& sed --in-place -e "s|SUPERVISOR_IMAGE=.*|SUPERVISOR_IMAGE=$(DEPLOY_REGISTRY)$(IMAGE) |" config/env \
	&& docker run -d --name resin_supervisor_1 --privileged -v $$(pwd)/config.json:/usr/src/app/config/config.json -v $$(pwd)/config/env:/usr/src/app/config/env -v /sys/fs/cgroup:/sys/fs/cgroup:ro resin/resin-supervisor-dind:$(SUPERVISOR_VERSION)

stop-supervisor:
	# Stop docker and remove volumes to prevent us from running out of loopback devices,
	# as per https://github.com/jpetazzo/dind/issues/19
	-docker exec resin_supervisor_1 bash -c "systemctl stop docker" || true
	-docker stop resin_supervisor_1 > /dev/null || true
	-docker rm -f --volumes resin_supervisor_1 > /dev/null || true

supervisor: gosuper
	cp Dockerfile.$(ARCH) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	docker build --no-cache=$(DISABLE_CACHE) -t resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION) .
	-rm Dockerfile

deploy: supervisor
	docker tag -f $(IMAGE) $(DEPLOY_REGISTRY)$(IMAGE)
	docker push $(DEPLOY_REGISTRY)$(IMAGE)

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
	docker run --name resin_test_gosuper_$(JOB_NAME) resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor/gosuper && ./test_formatting.sh && go test -v ./gosuper"
	docker rm --volumes -f resin_test_gosuper_$(JOB_NAME)

format-gosuper: go-builder
	-docker rm --volumes -f resin_test_gosuper_$(JOB_NAME) || true
	docker run --name resin_test_gosuper_$(JOB_NAME) -v $(shell pwd)/gosuper:/usr/src/app/src/resin-supervisor/gosuper resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor/gosuper && go fmt ./..."
	docker rm --volumes -f resin_test_gosuper_$(JOB_NAME)

test-integration: go-builder
	-docker rm --volumes -f resin_test_integration_$(JOB_NAME) || true
	docker run --name resin_test_integration_$(JOB_NAME) --net=host -e SUPERVISOR_IP="$(shell docker inspect --format '{{ .NetworkSettings.IPAddress }}' resin_supervisor_1)" --volumes-from resin_supervisor_1 resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor/gosuper && go test -v ./supertest"
	docker rm --volumes -f resin_test_integration_$(JOB_NAME)

.PHONY: supervisor deploy supervisor-dind run-supervisor
