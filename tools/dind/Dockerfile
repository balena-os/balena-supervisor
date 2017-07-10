FROM resin/resin-base:2

VOLUME /var/lib/docker
VOLUME /resin-data

RUN apt-get update \
	&& apt-get install -y \
	ifupdown \
	rsync \
	dropbear \
	aufs-tools \
	&& rm -rf /var/lib/apt/lists/*

ENV DOCKER_VERSION 1.10.3
ENV RELEASE_NAME jessie

# Change to 'true' to allow blank password dropbear logins on dind HostOS
ARG PASSWORDLESS_DROPBEAR=false

COPY config/certs/ /usr/local/share/ca-certificates/
RUN rm -f /usr/local/share/ca-certificates/.keepme ; update-ca-certificates

RUN apt-key adv --keyserver hkp://pgp.mit.edu:80 --recv-keys 58118E89F3A912897C070ADBF76221572C52609D \
	&& echo deb https://apt.dockerproject.org/repo debian-${RELEASE_NAME} main > /etc/apt/sources.list.d/docker.list \
	&& apt-get update || true \
	&& apt-get --force-yes install docker-engine=${DOCKER_VERSION}-0~${RELEASE_NAME} \
	&& rm -rf /var/lib/apt/lists/*

ENV DIND_COMMIT 3b5fac462d21ca164b3778647420016315289034
RUN curl -sL https://raw.githubusercontent.com/docker/docker/${DIND_COMMIT}/hack/dind > /usr/bin/dind \
	&& chmod +x /usr/bin/dind

RUN passwd -d root

# Change os release to a resin-sync compatible one
RUN sed -i 's/\(PRETTY_NAME=\).*/\1"ResinOS 1.2.1+dind"/' /etc/os-release
RUN echo 'VARIANT_ID="dev"' >> /etc/os-release

COPY config/openvpn/ /etc/openvpn/
COPY config/dropbear/config /etc/default/dropbear
COPY config/services/ /etc/systemd/system/
COPY resin-vars vpn-init /usr/src/app/

RUN if [ "$PASSWORDLESS_DROPBEAR" = "true" ]; then sed -i 's/\(DROPBEAR_EXTRA_ARGS=\).*/\1"-B"/' /etc/default/dropbear; fi

RUN systemctl enable resin-supervisor-dind

COPY supervisor-image.tar /usr/src/
