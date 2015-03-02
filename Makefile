DISABLE_CACHE = 'false'

ARCH = rpi# rpi/x86_64/i386

DEPLOY_REGISTRY = registry.resindev.io:5000/

SUPERVISOR_VERSION = latest

all: supervisor 

IMAGE = "resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION)"

clean:
	-rm Dockerfile

supervisor:
	cp Dockerfile.$(ARCH) Dockerfile
	echo "ENV VERSION "`jq -r .version package.json` >> Dockerfile
	docker build --no-cache=$(DISABLE_CACHE) -t resin/$(ARCH)-supervisor:$(SUPERVISOR_VERSION) .
	-rm Dockerfile

deploy: supervisor
	docker tag -f $(IMAGE) $(DEPLOY_REGISTRY)$(IMAGE)
	docker push $(DEPLOY_REGISTRY)$(IMAGE)

run-supervisor-x86_64:
	docker run --privileged -d -v /var/run/docker.sock:/run/docker.sock -v /boot/config.json:/boot/config.json -v /:/mnt/root -v /resin-data/resin-supervisor:/data -v /proc/net/fib_trie:/mnt/fib_trie -v /var/log/supervisor-log:/var/log -e API_ENDPOINT=https://staging.resin.io -e REGISTRY_ENDPOINT=registry.staging.resin.io -e PUBNUB_SUBSCRIBE_KEY=sub-c-bananas -e PUBNUB_PUBLISH_KEY=pub-c-bananas -e MIXPANEL_TOKEN=bananasbananas  resin/x86_64-supervisor /start
run-supervisor-i386:
	docker run --privileged -d -v /var/run/docker.sock:/run/docker.sock -v /boot/config.json:/boot/config.json -v /:/mnt/root -v /resin-data/resin-supervisor:/data -v /proc/net/fib_trie:/mnt/fib_trie -v /var/log/supervisor-log:/var/log -e API_ENDPOINT=https://staging.resin.io -e REGISTRY_ENDPOINT=registry.staging.resin.io -e PUBNUB_SUBSCRIBE_KEY=sub-c-bananas -e PUBNUB_PUBLISH_KEY=pub-c-bananas -e MIXPANEL_TOKEN=bananasbananas  resin/i386-supervisor /start

.PHONY: supervisor deploy run-supervisor-x86_64 run-supervisor-i386
