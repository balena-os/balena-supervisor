DISABLE_CACHE = 'false'

ARCH = rpi# rpi/x86_64/i386

SUPERVISOR_VERSION = latest

BUILDSTEP_VERSION = master

BUILDSTEP_REPO = resin/rpi-buildstep-armv6hf

# This allows using a cache for building the supervisor, making it much faster.
CACHE_VOLUME = ~/cache/resin-supervisor

all: supervisor 

IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"
VERSIONED_IMAGES = "$(shell docker images --all | grep $(BUILDSTEP_VERSION) | awk '{print $$1}')"
BUILDSTEP_PRESENT = $(shell echo $(VERSIONED_IMAGES) | grep --extended-regexp '$(BUILDSTEP_REPO)(\s|$$)' )
SUPERVISOR_BASE_PRESENT = $(shell echo $(VERSIONED_IMAGES) | grep --extended-regexp 'resin/supervisor-base(\s|$$)' )
ACCELERATOR = $(shell docker ps --all | grep buildstep-accelerator-$(BUILDSTEP_VERSION) | awk '{print $$1}' )

clean:
ifeq "$(ARCH)" "rpi"
	-docker rm -f build-supervisor-base 2> /dev/null
	-docker rmi resin/supervisor-base:latest
	-docker rmi resin/supervisor-base:$(BUILDSTEP_VERSION)
	-docker rm buildstep-accelerator-$(BUILDSTEP_VERSION) 2> /dev/null
	-rm -rf $(CACHE_VOLUME)
	@echo "Older images cleaned."
endif

supervisor-base:
ifeq "$(ARCH)" "rpi"
ifneq ($(SUPERVISOR_BASE_PRESENT) , )
	@echo "Using existing supervisor base from resin/supervisor-base:$(BUILDSTEP_VERSION)"
else
	docker pull $(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)
	-docker rm -f build-supervisor-base 2> /dev/null
	docker run --name build-supervisor-base $(BUILDSTEP_REPO):$(BUILDSTEP_VERSION) bash -c "apt-get -q update && apt-get install -qqy libsqlite3-dev socat supervisor && apt-get clean && rm -rf /var/lib/apt/lists/"
	docker commit build-supervisor-base resin/supervisor-base:$(BUILDSTEP_VERSION)
	-docker rm build-supervisor-base 2> /dev/null
endif
	docker tag -f resin/supervisor-base:$(BUILDSTEP_VERSION) resin/supervisor-base:latest
endif

supervisor: supervisor-base
	cp Dockerfile.$(ARCH) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	docker build --no-cache=$(DISABLE_CACHE) -t resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION) .
	rm Dockerfile

supervisor-accelerated: supervisor-base
ifneq "$(ARCH)" "rpi"
	@echo 'Can only accelerate an rpi build.'
else
ifeq ($(ACCELERATOR) , )
	@echo 'Supervisor accelerator not found - Downloading resin/buildstep-accelerator and preparing.'
	docker pull resin/rpi-buildstep-accelerator:$(BUILDSTEP_VERSION)
	-docker rm buildstep-accelerator-$(BUILDSTEP_VERSION) 2> /dev/null
	docker run --name=buildstep-accelerator-$(BUILDSTEP_VERSION) -v /.a resin/rpi-buildstep-accelerator:$(BUILDSTEP_VERSION) /prepare-accelerator.sh
endif
	-docker rm -f build-supervisor-latest 2> /dev/null
	docker run --name build-supervisor-latest --volume $(CACHE_VOLUME):/cache --volumes-from `docker ps --all | grep buildstep-accelerator-$(BUILDSTEP_VERSION) | awk '{print $$1}'`:ro --env VERSION=`jq -r .version package.json` -v `pwd`:/tmp/app resin/supervisor-base:latest bash -i -c ". /.env && cp -r /tmp/app /app && /build/builder"
	docker commit build-supervisor-latest $(IMAGE) > /dev/null
	-docker rm build-supervisor-latest 2> /dev/null
endif

run-supervisor-x86_64:
	docker run --privileged -d -v /var/run/docker.sock:/run/docker.sock -v /boot/config.json:/boot/config.json -v /:/mnt/root -v /resin-data/resin-supervisor:/data -v /proc/net/fib_trie:/mnt/fib_trie -v /var/log/supervisor-log:/var/log -e API_ENDPOINT=https://staging.resin.io -e REGISTRY_ENDPOINT=registry.staging.resin.io -e PUBNUB_SUBSCRIBE_KEY=sub-c-bananas -e PUBNUB_PUBLISH_KEY=pub-c-bananas -e MIXPANEL_TOKEN=bananasbananas  resin/x86_64-supervisor /start
run-supervisor-i386:
	docker run --privileged -d -v /var/run/docker.sock:/run/docker.sock -v /boot/config.json:/boot/config.json -v /:/mnt/root -v /resin-data/resin-supervisor:/data -v /proc/net/fib_trie:/mnt/fib_trie -v /var/log/supervisor-log:/var/log -e API_ENDPOINT=https://staging.resin.io -e REGISTRY_ENDPOINT=registry.staging.resin.io -e PUBNUB_SUBSCRIBE_KEY=sub-c-bananas -e PUBNUB_PUBLISH_KEY=pub-c-bananas -e MIXPANEL_TOKEN=bananasbananas  resin/i386-supervisor /start

.PHONY: supervisor supervisor-accelerated run-supervisor-x86_64 run-supervisor-i386
