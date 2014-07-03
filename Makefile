DISABLE_CACHE = 'false'

IMAGE = resin/rpi-supervisor

SUPERVISOR_REGISTRY = registry.staging.resin.io

SUPERVISOR_VERSION = latest

BUILDSTEP_REGISTRY = registry.staging.resin.io

BUILDSTEP_VERSION = latest

all: supervisor 

supervisor:
	docker pull $(BUILDSTEP_REGISTRY)/resin/rpi-buildstep-armv6hf:$(BUILDSTEP_VERSION)
	docker tag $(BUILDSTEP_REGISTRY)/resin/rpi-buildstep-armv6hf:$(BUILDSTEP_VERSION) rpi-buildstep-armv6hf:latest
	docker build --no-cache=$(DISABLE_CACHE) -t $(IMAGE):$(SUPERVISOR_VERSION) .
	docker tag $(IMAGE):$(SUPERVISOR_VERSION) $(SUPERVISOR_REGISTRY)/$(IMAGE):$(SUPERVISOR_VERSION)


.PHONY: supervisor
