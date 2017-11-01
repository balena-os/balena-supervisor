ARG ARCH=amd64
FROM debian:jessie-20170723 as base
ARG ARCH
# Install the following utilities (required by openembedded)
# http://www.openembedded.org/wiki/Getting_started#Ubuntu_.2F_Debian
RUN apt-get -qq update \
	&& apt-get -qq install -y \
		build-essential \
		chrpath \
		cpio \
		curl \
		diffstat \
		file \
		gawk \
		git-core \
		libsdl1.2-dev \
		locales \
		python3 \
		texinfo \
		unzip \
		wget \
		xterm \
		sudo \
	&& rm -rf /var/lib/apt/lists/*

RUN locale-gen en_US.UTF-8
ENV LANG en_US.UTF-8
ENV LC_ALL en_US.UTF-8

ENV SOURCE_DIR /source
ENV DEST_DIR /dest
ENV SHARED_DOWNLOADS /yocto/shared-downloads
ENV SHARED_SSTATE /yocto/shared-sstate

ARG BUILDER_UID=1000
ARG BUILDER_GID=1000

COPY base-image /source
RUN cd /source && bash -ex build.sh

##############################################################################

# Build golang supervisor
FROM debian:jessie-20170723 as gosuper

RUN apt-get update \
	&& apt-get install -y \
		build-essential \
		curl \
		rsync \
	&& rm -rf /var/lib/apt/lists/

ENV GOLANG_VERSION 1.8.3
ENV GOLANG_DOWNLOAD_URL https://golang.org/dl/go$GOLANG_VERSION.linux-amd64.tar.gz
ENV GOLANG_DOWNLOAD_SHA256 1862f4c3d3907e59b04a757cfda0ea7aa9ef39274af99a784f5be843c80c6772

COPY gosuper/go-${GOLANG_VERSION}-patches /go-${GOLANG_VERSION}-patches

RUN mkdir /usr/src/go \
	&& cd /usr/src/go \
	&& curl -L -o go.tar.gz $GOLANG_DOWNLOAD_URL \
	&& echo "${GOLANG_DOWNLOAD_SHA256}  go.tar.gz" | sha256sum -c - \
	&& tar xzf go.tar.gz -C /usr/local \
	&& cd /usr/src \
	&& rm -rf go \
	&& export GOROOT_BOOTSTRAP=/usr/local/go-bootstrap \
	&& cp -r /usr/local/go /usr/local/go-bootstrap \
	&& cd /usr/local/go/src \
	&& patch -p2 -i /go-${GOLANG_VERSION}-patches/0001-dont-fail-when-no-mmx.patch \
	&& patch -p2 -i /go-${GOLANG_VERSION}-patches/0002-implement-atomic-quadword-ops-with-FILD-FISTP.patch \
	&& ./make.bash \
	&& rm -rf /usr/local/go-bootstrap

ENV UPX_VERSION 3.94
# UPX doesn't provide fingerprints so I checked this one manually
ENV UPX_SHA256 e1fc0d55c88865ef758c7e4fabbc439e4b5693b9328d219e0b9b3604186abe20

RUN mkdir /usr/src/upx \
	&& cd /usr/src/upx \
	&& curl -L -o upx.tar.xz https://github.com/upx/upx/releases/download/v$UPX_VERSION/upx-$UPX_VERSION-amd64_linux.tar.xz \
	&& echo "${UPX_SHA256}  upx.tar.xz" | sha256sum -c - \
	&& tar xf upx.tar.xz --strip-components=1 \
	&& cp ./upx /usr/bin/ \
	&& cd /usr/src \
	&& rm -rf upx

ENV GOPATH /go
ENV PATH $GOPATH/bin:/usr/local/go/bin:$PATH

COPY ./gosuper /go/src/resin-supervisor/gosuper

WORKDIR /go/src/resin-supervisor/gosuper

ENV GOOS linux
ENV GO386=387

ARG ARCH
RUN bash ./build.sh
RUN rsync -a --delete /go/bin/gosuper /build/

##############################################################################

# The node version here should match the version of the runtime image which is
# specified in the base-image subdirectory in the project
FROM resin/rpi-node:6.5-slim as rpi-node-base
FROM resin/armv7hf-node:6.5-slim as armv7hf-node-base
FROM resin/armel-node:6.5-slim as armel-node-base
FROM resin/aarch64-node:6.5-slim as aarch64-node-base

FROM resin/amd64-node:6.5-slim as amd64-node-base
RUN echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-start && chmod +x /usr/bin/cross-build-start \
	&& echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-end && chmod +x /usr/bin/cross-build-end

FROM resin/i386-node:6.5-slim as i386-node-base
RUN echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-start && chmod +x /usr/bin/cross-build-start \
	&& echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-end && chmod +x /usr/bin/cross-build-end

FROM i386-node-base as i386-nlp-node-base

# Build nodejs dependencies
FROM $ARCH-node-base as node
ARG ARCH

RUN [ "cross-build-start" ]

WORKDIR /usr/src/app

RUN apt-get update \
	&& apt-get install -y \
		g++ \
		git \
		libsqlite3-dev \
		make \
		python \
		rsync \
		wget \
	&& rm -rf /var/lib/apt/lists/

RUN mkdir -p rootfs-overlay && \
	ln -s /lib rootfs-overlay/lib64

COPY package.json /usr/src/app/

# Install only the production modules that have C extensions
RUN JOBS=MAX npm install --production --no-optional --unsafe-perm \
	&& npm dedupe

COPY webpack.config.js fix-jsonstream.js /usr/src/app/
COPY src /usr/src/app/src
COPY test /usr/src/app/test

# Install devDependencies, build the coffeescript and then prune the deps
RUN cp -R node_modules node_modules_prod \
	&& npm install --no-optional --unsafe-perm \
	&& npm run test \
	&& npm run build \
	&& rm -rf node_modules \
	&& mv node_modules_prod node_modules

# Remove various uneeded filetypes in order to reduce space
# We also remove the spurious node.dtps, see https://github.com/mapbox/node-sqlite3/issues/861
RUN find . -path '*/coverage/*' -o -path '*/test/*' -o -path '*/.nyc_output/*' \
		-o -name '*.tar.*'      -o -name '*.in'     -o -name '*.cc' \
		-o -name '*.c'          -o -name '*.coffee' -o -name '*.eslintrc' \
		-o -name '*.h'          -o -name '*.html'   -o -name '*.markdown' \
		-o -name '*.md'         -o -name '*.patch'  -o -name '*.png' \
		-o -name '*.yml' \
		-delete \
	&& find . -type f -path '*/node_modules/sqlite3/deps*' -delete \
	&& find . -type f -path '*/node_modules/knex/build*' -delete \
	&& rm -rf node_modules/sqlite3/node.dtps

# Create /var/run/resin for the gosuper to place its socket in
RUN mkdir -p rootfs-overlay/var/run/resin

COPY entry.sh run.sh package.json rootfs-overlay/usr/src/app/

COPY inittab rootfs-overlay/etc/inittab

RUN rsync -a --delete report.xml coverage node_modules dist rootfs-overlay /build

RUN [ "cross-build-end" ]

##############################################################################

# Minimal runtime image
FROM scratch
ARG ARCH
ARG VERSION=master
ARG DEFAULT_PUBNUB_PUBLISH_KEY=pub-c-bananas
ARG DEFAULT_PUBNUB_SUBSCRIBE_KEY=sub-c-bananas
ARG DEFAULT_MIXPANEL_TOKEN=bananasbananas

COPY --from=base /dest/ /

WORKDIR /usr/src/app

COPY --from=node /build/dist ./dist
COPY --from=node /build/node_modules ./node_modules
COPY --from=gosuper /build/gosuper ./gosuper
COPY --from=node /build/rootfs-overlay/ /

VOLUME /data

ENV CONFIG_MOUNT_POINT=/boot/config.json \
	LED_FILE=/dev/null \
	SUPERVISOR_IMAGE=resin/$ARCH-supervisor \
	VERSION=$VERSION \
	DEFAULT_PUBNUB_PUBLISH_KEY=$DEFAULT_PUBNUB_PUBLISH_KEY \
	DEFAULT_PUBNUB_SUBSCRIBE_KEY=$DEFAULT_PUBNUB_SUBSCRIBE_KEY \
	DEFAULT_MIXPANEL_TOKEN=$DEFAULT_MIXPANEL_TOKEN

CMD [ "/sbin/init" ]
