FROM resin/resin-base:2

VOLUME /var/lib/docker
VOLUME /resin-data

RUN apt-get update \
	&& apt-get install -y \
	ifupdown \
	rsync \
	&& rm -rf /var/lib/apt/lists/*

ENV DOCKER_VERSION 1.10.3
ENV RELEASE_NAME jessie

RUN apt-key adv --keyserver hkp://pgp.mit.edu:80 --recv-keys 58118E89F3A912897C070ADBF76221572C52609D \
	&& echo deb https://apt.dockerproject.org/repo debian-${RELEASE_NAME} main > /etc/apt/sources.list.d/docker.list \
	&& apt-get update || true \
	&& apt-get --force-yes install docker-engine=${DOCKER_VERSION}-0~${RELEASE_NAME} \
	&& mkdir -p /etc/systemd/system/docker.service.d \
	&& rm -rf /var/lib/apt/lists/*

# Change os release to a resin-sync compatible one
RUN sed -i 's/\(PRETTY_NAME=\).*/\1"ResinOS 1.2.1+dind"/' /etc/os-release

COPY config/openvpn/ /etc/openvpn/
COPY config/services/ /etc/systemd/system/
COPY resin-vars vpn-init /usr/src/app/

RUN systemctl enable resin-supervisor-dind
