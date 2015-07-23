DISABLE_CACHE = 'false'

ARCH = rpi# rpi/amd64/i386/armv7hf

DEPLOY_REGISTRY = registry.resindev.io/

SUPERVISOR_VERSION = master

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
	-docker stop resin_supervisor_1 > /dev/null
	# Remove volumes to prevent us from running out of loopback devices,
	# as per https://github.com/jpetazzo/dind/issues/19
	-docker rm -f --volumes resin_supervisor_1 > /dev/null

supervisor: gosuper
	cp Dockerfile.$(ARCH) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	docker build --no-cache=$(DISABLE_CACHE) -t resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION) .
	-rm Dockerfile

deploy: supervisor
	docker tag -f $(IMAGE) $(DEPLOY_REGISTRY)$(IMAGE)
	docker push $(DEPLOY_REGISTRY)$(IMAGE)

go-builder:
	docker build -f Dockerfile.gosuper -t resin/go-supervisor-builder:$(SUPERVISOR_VERSION) .

gosuper: go-builder
	-mkdir -p gosuper/bin
	docker run -v $(shell pwd)/gosuper/bin:/usr/src/app/bin -e USER_ID=$(shell id -u) -e GROUP_ID=$(shell id -g) -e GOARCH=$(GOARCH) resin/go-supervisor-builder:$(SUPERVISOR_VERSION)

test-gosuper: go-builder
	docker run -v $(shell pwd)/gosuper/bin:/usr/src/app/bin resin/go-supervisor-builder:$(SUPERVISOR_VERSION) bash -c "cd src/resin-supervisor && go test -v ./..."

.PHONY: supervisor deploy supervisor-dind run-supervisor
