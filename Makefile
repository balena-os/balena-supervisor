DISABLE_CACHE = 'false'

ARCH = rpi# rpi/amd64/i386/armv7hf

DEPLOY_REGISTRY = registry.resindev.io:5000/

SUPERVISOR_VERSION = master

all: supervisor 

IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"

clean:
	-rm Dockerfile

supervisor-dind:
	cd tools/dind && docker build --no-cache=$(DISABLE_CACHE) -t resin/resin-supervisor-dind:$(SUPERVISOR_VERSION) .

run-supervisor: supervisor-dind
	-docker stop resin_supervisor_1 > /dev/null
	-docker rm -f resin_supervisor_1 > /dev/null
	cd tools/dind \
	&& sed --in-place -e "s|SUPERVISOR_IMAGE=.*|SUPERVISOR_IMAGE=resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)|" config/env \
	&& docker run -d --name resin_supervisor_1 --privileged -v $$(pwd)/config.json:/usr/src/app/config/config.json -v $$(pwd)/config/env:/usr/src/app/config/env -v /sys/fs/cgroup:/sys/fs/cgroup:ro resin/resin-supervisor-dind:$(SUPERVISOR_VERSION)

supervisor:
	cp Dockerfile.$(ARCH) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	docker build --no-cache=$(DISABLE_CACHE) -t resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION) .
	-rm Dockerfile

deploy: supervisor
	docker tag -f $(IMAGE) $(DEPLOY_REGISTRY)$(IMAGE)
	docker push $(DEPLOY_REGISTRY)$(IMAGE)

.PHONY: supervisor deploy supervisor-dind run-supervisor
