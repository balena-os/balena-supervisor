ARG ARCH=amd64
ARG NODE_VERSION=12.16.2

FROM balenalib/$ARCH-alpine-supervisor-base:3.11 as BUILD

ARG ARCH
ARG NODE_VERSION
ARG NODE_ARCHIVE="node-no-intl-v${NODE_VERSION}-linux-alpine-${ARCH}.tar.gz"
ARG S3_BASE="https://resin-packages.s3.amazonaws.com"
ARG NODE_LOCATION="${S3_BASE}/node/v${NODE_VERSION}/${NODE_ARCHIVE}"

# DO NOT REMOVE THE cross-build-* COMMANDS
# The following commands are absolutely needed. When we
# build for ARM architectures, we run this Dockerfile
# through sed, which uncomments these lines. There were
# other options for achieving the same setup, but this seems
# to be the least intrusive. The commands start commented
# out because the default build for balenaCI is amd64 (and
# we can't run any sed preprocessing on it there)
# RUN ["cross-build-start"]

WORKDIR /usr/src/app

RUN apk add --no-cache \
	g++ \
	git \
	make \
	python \
	curl \
	binutils \
	libgcc \
	libstdc++ \
	libuv \
	sqlite-libs \
	sqlite-dev \
	dbus-dev

COPY build-utils/node-sums.txt .

# Install node from balena's prebuilt cache
RUN curl -SLO "${NODE_LOCATION}" \
	&& grep "${NODE_ARCHIVE}" node-sums.txt | sha256sum -c - \
	&& tar -xzf "${NODE_ARCHIVE}" -C /usr/local --strip-components=1 \
	&& rm -f "${NODE_ARCHIVE}" \
	&& strip /usr/local/bin/node

COPY package*.json ./

RUN npm ci --build-from-source --sqlite=/usr/lib

# We only run these commands when executing through
# livepush, so they are presented as livepush directives
#dev-run=apk add --no-cache ip6tables iptables
#dev-copy=entry.sh .
#dev-cmd-live=LIVEPUSH=1 ./entry.sh

COPY build-utils ./build-utils
COPY webpack.config.js tsconfig.json tsconfig.release.json ./
COPY src ./src
COPY test ./test
COPY typings ./typings

RUN npm run test-nolint \
	&& npm run build

# Run the production install here, to avoid the npm dependency on
# the later stage
RUN npm ci --production --no-optional --unsafe-perm --build-from-source --sqlite=/usr/lib \
	&& npm cache clean --force \
	# For some reason this doesn't get cleared with the other
	# cache
	&& rm -rf node_modules/.cache \
	# Remove various uneeded filetypes in order to reduce space
	# We also remove the spurious node.dtps, see https://github.com/mapbox/node-sqlite3/issues/861
	&& find . -path '*/coverage/*' -o -path '*/test/*' -o -path '*/.nyc_output/*' \
		-o -name '*.tar.*'      -o -name '*.in'     -o -name '*.cc' \
		-o -name '*.c'          -o -name "*.ts"     -o -name '*.eslintrc' \
		-o -name '*.h'          -o -name '*.html'   -o -name '*.markdown' \
		-o -name '*.md'         -o -name '*.patch'  -o -name '*.png' \
		-o -name '*.yml' \
		-delete \
	&& find . -type f -path '*/node_modules/sqlite3/deps*' -delete \
	&& find . -type f -path '*/node_modules/knex/build*' -delete \
	&& rm -rf node_modules/sqlite3/node.dtps


# RUN ["cross-build-end"]

FROM balenalib/$ARCH-alpine-supervisor-base:3.11

# RUN ["cross-build-start"]

RUN apk add --no-cache \
	ca-certificates \
	kmod \
	iptables \
	ip6tables \
	rsync \
	avahi \
	dbus \
	libstdc++ \
	sqlite-libs

WORKDIR /usr/src/app

COPY --from=BUILD /usr/local/bin/node /usr/local/bin/node
COPY --from=BUILD /usr/src/app/dist ./dist
COPY --from=BUILD /usr/src/app/package.json ./
COPY --from=BUILD /usr/src/app/node_modules ./node_modules

COPY entry.sh .

RUN mkdir -p rootfs-overlay && \
	(([ ! -d rootfs-overlay/lib64 ] && ln -s /lib rootfs-overlay/lib64) || true)

ARG ARCH
ARG VERSION=master
ARG DEFAULT_MIXPANEL_TOKEN=bananasbananas
ENV CONFIG_MOUNT_POINT=/boot/config.json \
	LED_FILE=/dev/null \
	SUPERVISOR_IMAGE=balena/$ARCH-supervisor \
	VERSION=$VERSION \
	DEFAULT_MIXPANEL_TOKEN=$DEFAULT_MIXPANEL_TOKEN
COPY avahi-daemon.conf /etc/avahi/avahi-daemon.conf

VOLUME /data
HEALTHCHECK --interval=5m --start-period=1m --timeout=30s --retries=3 \
	CMD wget http://127.0.0.1:${LISTEN_PORT:-48484}/v1/healthy -O - -q

# RUN ["cross-build-end"]

CMD ["/usr/src/app/entry.sh"]

