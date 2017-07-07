# Dockerfile for a docker-in-docker supervisor builder
FROM library/docker:17.06-dind
RUN apk add --no-cache \
	make \
	jq \
	git \
	bash
WORKDIR /src

COPY . /src
