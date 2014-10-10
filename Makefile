DISABLE_CACHE = 'false'

IMAGE = resin/rpi-supervisor

SUPERVISOR_REGISTRY = registry.staging.resin.io

SUPERVISOR_VERSION = latest

BUILDSTEP_REGISTRY = registry.staging.resin.io

BUILDSTEP_VERSION = latest

BUILDSTEP_REPO = resin/rpi-buildstep-armv6hf

# This allows using a cache for building the supervisor, making it much faster.
CACHE_VOLUME = # --volume /home/vagrant/cache:/cache

all: supervisor 

VERSIONED_IMAGES = "$(shell docker images --all | grep $(BUILDSTEP_VERSION) | awk '{print $$1}')"
BUILDSTEP_PRESENT = $(shell echo $(VERSIONED_IMAGES) | grep --extended-regexp '$(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO)(\s|$$)' )
SUPERVISOR_BASE_PRESENT = $(shell echo $(VERSIONED_IMAGES) | grep --extended-regexp 'resin/supervisor-base(\s|$$)' )

supervisor-base:
ifneq ($(BUILDSTEP_PRESENT) , )
	@echo "Using existing build step from $(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)"
else
	docker pull $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)
endif
ifneq ($(SUPERVISOR_BASE_PRESENT) , )
	@echo "Using existing supervisor base from resin/supervisor-base:$(BUILDSTEP_VERSION)"
else
	docker rm -f build-supervisor-base 2> /dev/null || true
	docker run --name build-supervisor-base $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION) bash -c "apt-get -q update && apt-get install -qqy openvpn libsqlite3-dev socat && apt-get clean && rm -rf /var/lib/apt/lists/"
	docker commit build-supervisor-base resin/supervisor-base:$(BUILDSTEP_VERSION)
endif
	docker tag resin/supervisor-base:$(BUILDSTEP_VERSION) resin/supervisor-base:latest

supervisor: supervisor-base
	docker build --no-cache=$(DISABLE_CACHE) -t $(IMAGE):$(SUPERVISOR_VERSION) .
	docker tag $(IMAGE):$(SUPERVISOR_VERSION) $(SUPERVISOR_REGISTRY)/$(IMAGE):$(SUPERVISOR_VERSION)


ACCELERATOR = $(shell docker ps --all | grep buildstep-accelerator-$(BUILDSTEP_VERSION) | awk '{print $$1}' )

ifneq ($(ACCELERATOR) , )
supervisor-accelerated: supervisor-base
	docker rm -f build-supervisor-latest 2> /dev/null || true
	docker run --name build-supervisor-latest $(CACHE_VOLUME) --volumes-from $(ACCELERATOR):ro -v `pwd`:/tmp/app resin/supervisor-base:latest bash -i -c ". /.env && cp -r /tmp/app /app && /build/builder"
	docker commit build-supervisor-latest $(IMAGE):$(SUPERVISOR_VERSION) > /dev/null
	docker tag $(IMAGE):$(SUPERVISOR_VERSION) $(SUPERVISOR_REGISTRY)/$(IMAGE):$(SUPERVISOR_VERSION)
else
supervisor-accelerated:
	@echo 'Please run make accelerator in resin-buildstep to continue'
endif

supervisor-x86_64:
	tar --exclude="Dockerfile" --transform='flags=r;s|Dockerfile.x86_64|Dockerfile|' -c . | docker build -t resin/x86_64-supervisor -

run-supervisor-x86_64:
	docker run --privileged -d -v /var/run/docker.sock:/run/docker.sock -e API_ENDPOINT=https://staging.resin.io -e REGISTRY_ENDPOINT=registry.staging.resin.io -e PUBNUB_SUBSCRIBE_KEY=sub-c-bananas -e PUBNUB_PUBLISH_KEY=pub-c-bananas -e MIXPANEL_TOKEN=bananasbananas  resin/x86_64-supervisor /start

supervisor-i386:
	tar --exclude="Dockerfile" --transform='flags=r;s|Dockerfile.i386|Dockerfile|' -c . | docker build -t resin/i386-supervisor -

run-supervisor-i386:
	docker run --privileged -d -v /var/run/docker.sock:/run/docker.sock -e API_ENDPOINT=https://staging.resin.io -e REGISTRY_ENDPOINT=registry.staging.resin.io -e PUBNUB_SUBSCRIBE_KEY=sub-c-bananas -e PUBNUB_PUBLISH_KEY=pub-c-bananas -e MIXPANEL_TOKEN=bananasbananas  resin/i386-supervisor /start

.PHONY: supervisor supervisor-accelerated supervisor-x86_64 run-supervisor-x86_64 supervisor-i386 run-supervisor-i386
