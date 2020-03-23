ARG ARCH=amd64
ARG NPM_VERSION=6.9.0

# The node version here should match the version of the runtime image which is
# specified in the base-image subdirectory in the project
FROM balenalib/raspberry-pi-node:10-run as rpi-node-base
FROM balenalib/armv7hf-node:10-run as armv7hf-node-base
FROM balenalib/aarch64-node:10-run as aarch64-node-base
RUN [ "cross-build-start" ]
RUN sed -i '/security.debian.org jessie/d' /etc/apt/sources.list
RUN [ "cross-build-end" ]

FROM balenalib/amd64-node:10-run as amd64-node-base
RUN echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-start && chmod +x /usr/bin/cross-build-start \
	&& echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-end && chmod +x /usr/bin/cross-build-end

FROM balenalib/i386-node:10-run as i386-node-base
RUN echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-start && chmod +x /usr/bin/cross-build-start \
	&& echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-end && chmod +x /usr/bin/cross-build-end

FROM balenalib/i386-nlp-node:6-jessie as i386-nlp-node-base
RUN echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-start && chmod +x /usr/bin/cross-build-start \
	&& echo '#!/bin/sh\nexit 0' > /usr/bin/cross-build-end && chmod +x /usr/bin/cross-build-end

# Setup webpack building base images
# We always do the webpack build on amd64, cause it's way faster
FROM amd64-node-base as rpi-node-build
FROM amd64-node-base as amd64-node-build
FROM amd64-node-base as armv7hf-node-build
FROM amd64-node-base as aarch64-node-build
FROM amd64-node-base as i386-node-build
FROM balenalib/amd64-node:6-build as i386-nlp-node-build
##############################################################################

FROM $ARCH-node-build as node-build


WORKDIR /usr/src/app

RUN apt-get update \
	&& apt-get install -y \
		g++ \
		git \
		libsqlite3-dev \
		make \
		python \
		rsync \
		curl \
	&& rm -rf /var/lib/apt/lists/

COPY package.json package-lock.json /usr/src/app/

ARG NPM_VERSION
# We first ensure that every architecture has an npm version
# which can do an npm ci, then we perform the ci using this
# temporary version
RUN curl -LOJ https://www.npmjs.com/install.sh && \
	# This is required to avoid a bug in uid-number
	# https://github.com/npm/uid-number/issues/7
	npm config set unsafe-perm true && \
	npm_install="#{NPM_VERSION}" npm_config_prefix=/tmp sh ./install.sh && \
	JOBS=MAX /tmp/bin/npm ci --no-optional --unsafe-perm

COPY webpack.config.js fix-jsonstream.js hardcode-migrations.js tsconfig.json tsconfig.release.json /usr/src/app/
COPY src /usr/src/app/src
COPY test /usr/src/app/test
COPY typings /usr/src/app/typings

RUN npm run test-nolint \
	&& npm run build

##############################################################################

# Build nodejs dependencies
FROM $ARCH-node-base as node-deps

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
	curl \
	&& rm -rf /var/lib/apt/lists/

RUN mkdir -p rootfs-overlay && \
	ln -s /lib rootfs-overlay/lib64

COPY package.json package-lock.json /usr/src/app/

ARG NPM_VERSION
# Install only the production modules that have C extensions
RUN curl -LOJ https://www.npmjs.com/install.sh && \
	npm config set unsafe-perm true && \
	npm_install="${NPM_VERSION}" npm_config_prefix=/tmp sh ./install.sh && \
	JOBS=MAX /tmp/bin/npm ci --no-optional --unsafe-perm --production

# Remove various uneeded filetypes in order to reduce space
# We also remove the spurious node.dtps, see https://github.com/mapbox/node-sqlite3/issues/861
RUN find . -path '*/coverage/*' -o -path '*/test/*' -o -path '*/.nyc_output/*' \
	-o -name '*.tar.*'      -o -name '*.in'     -o -name '*.cc' \
	-o -name '*.c'          -o -name '*.coffee' -o -name '*.eslintrc' \
	-o -name '*.h'          -o -name '*.html'   -o -name '*.markdown' \
	-o -name '*.md'         -o -name '*.patch'  -o -name '*.png' \
	-o -name '*.yml'        -o -name "*.ts" \
	-delete \
	&& find . -type f -path '*/node_modules/sqlite3/deps*' -delete \
	&& find . -type f -path '*/node_modules/knex/build*' -delete \
	&& rm -rf node_modules/sqlite3/node.dtps

COPY entry.sh package.json rootfs-overlay/usr/src/app/

RUN rsync -a --delete node_modules rootfs-overlay /build

RUN [ "cross-build-end" ]

##############################################################################

# Minimal runtime image
FROM balena/$ARCH-supervisor-base:v1.4.7

WORKDIR /usr/src/app

COPY --from=node-build /usr/src/app/dist ./dist
COPY --from=node-deps /build/node_modules ./node_modules
COPY --from=node-deps /build/rootfs-overlay/ /

# Remove default nproc limit for Avahi for it to work in-container
COPY avahi-daemon.conf /etc/avahi/avahi-daemon.conf

VOLUME /data

ARG ARCH
ARG VERSION=master
ARG DEFAULT_MIXPANEL_TOKEN=bananasbananas
ENV CONFIG_MOUNT_POINT=/boot/config.json \
	LED_FILE=/dev/null \
	SUPERVISOR_IMAGE=resin/$ARCH-supervisor \
	VERSION=$VERSION \
	DEFAULT_MIXPANEL_TOKEN=$DEFAULT_MIXPANEL_TOKEN

HEALTHCHECK --interval=5m --start-period=1m --timeout=30s --retries=3 \
	CMD wget -qO- http://127.0.0.1:${LISTEN_PORT:-48484}/v1/healthy || exit 1

CMD [ "./entry.sh" ]
