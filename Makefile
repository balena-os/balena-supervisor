DISABLE_CACHE = 'false'

IMAGE = resin/rpi-supervisor

SUPERVISOR_REGISTRY = registry.staging.resin.io

SUPERVISOR_VERSION = latest

BUILDSTEP_REGISTRY = registry.staging.resin.io

BUILDSTEP_VERSION = latest

BUILDSTEP_REPO = resin/rpi-buildstep-armv6hf

all: supervisor 

supervisor:
	docker pull $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION)
	docker tag $(BUILDSTEP_REGISTRY)/$(BUILDSTEP_REPO):$(BUILDSTEP_VERSION) resin/supervisor-base:latest
	docker build --no-cache=$(DISABLE_CACHE) -t $(IMAGE):$(SUPERVISOR_VERSION) .
	docker tag $(IMAGE):$(SUPERVISOR_VERSION) $(SUPERVISOR_REGISTRY)/$(IMAGE):$(SUPERVISOR_VERSION)


.PHONY: supervisor
