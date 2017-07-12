# Dockerfile for a docker-in-docker supervisor builder
FROM library/docker:17.06-dind
RUN apk add --no-cache \
	make \
	jq \
	git \
	bash \
	nodejs \
	nodejs-npm

WORKDIR /src
COPY ./automation/package.json /src/automation/package.json
RUN cd automation \
	&& JOBS=max npm install \
	&& npm cache clean

COPY . /src
