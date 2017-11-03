FROM resin/resin-base:v2.9.2

VOLUME /var/lib/docker
VOLUME /resin-data

RUN apt-get update \
	&& apt-get install -y \
	ifupdown \
	rsync \
	dropbear \
	aufs-tools \
	&& rm -rf /var/lib/apt/lists/*

ENV BALENA_VERSION 17.06-rev1
ENV RELEASE_NAME jessie

# Change to 'true' to allow blank password dropbear logins on dind HostOS
ARG PASSWORDLESS_DROPBEAR=false

COPY config/certs/ /usr/local/share/ca-certificates/
RUN rm -f /usr/local/share/ca-certificates/.keepme ; update-ca-certificates

RUN curl -sL "https://github.com/resin-os/balena/releases/download/${BALENA_VERSION}/balena-${BALENA_VERSION}-x86_64.tar.gz" \
	| tar xzv -C /usr/bin --strip-components=1

RUN curl -sL https://raw.githubusercontent.com/resin-os/balena/${BALENA_VERSION}/hack/dind > /usr/bin/dind \
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

ENV DOCKER_HOST unix:///var/run/docker.sock
RUN groupadd docker
RUN systemctl enable resin-supervisor-dind

COPY supervisor-image.tar /usr/src/
