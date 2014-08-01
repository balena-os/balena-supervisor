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

BUILDSTEP_PRESENT = $(shell docker images --all | grep $(BUILDSTEP_VERSION) | awk '{print $$1}' | grep -xF $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO) )

supervisor:
ifneq ($(BUILDSTEP_PRESENT) , )
	echo "Using existing Build step from $(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)"
else
	docker pull $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)
endif
	docker tag $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION) resin/supervisor-base:latest
	docker build --no-cache=$(DISABLE_CACHE) -t $(IMAGE):$(SUPERVISOR_VERSION) .
	docker tag $(IMAGE):$(SUPERVISOR_VERSION) $(SUPERVISOR_REGISTRY)/$(IMAGE):$(SUPERVISOR_VERSION)


ACCELERATOR = $(shell docker ps --all | grep buildstep-accelerator-latest | awk '{print $$1}' )

ifneq ($(ACCELERATOR) , )
supervisor-accelerated:
ifneq ($(BUILDSTEP_PRESENT) , )
	echo "Using existing Build step from $(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)"
else
	docker pull $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)
endif
	docker tag $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION) resin/supervisor-base:latest
	docker rm -f build-supervisor-latest 2> /dev/null || true
	docker run --name build-supervisor-latest $(CACHE_VOLUME) --volumes-from  $(ACCELERATOR):ro -v `pwd`:/tmp/app resin/supervisor-base:latest bash -i -c ". /.env && cp -r /tmp/app /app && /build/builder"
	docker commit build-supervisor-latest $(IMAGE):$(SUPERVISOR_VERSION) > /dev/null
	docker tag $(IMAGE):$(SUPERVISOR_VERSION) $(SUPERVISOR_REGISTRY)/$(IMAGE):$(SUPERVISOR_VERSION)
else
supervisor-accelerated:
	echo 'Please run make accelerator in resin-buildstep to continue'
endif


.PHONY: supervisor supervisor-accelerated
