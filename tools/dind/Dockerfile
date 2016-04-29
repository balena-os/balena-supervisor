FROM resin/resin-base:1

VOLUME /var/lib/docker
VOLUME /resin-data

RUN apt-get update \
	&& apt-get install -y ifupdown \
	&& rm -rf /var/lib/apt/lists/*

ENV DOCKER_VERSION 1.6.2

# From get.docker.com script
RUN apt-key adv --keyserver hkp://p80.pool.sks-keyservers.net:80 --recv-keys 36A1D7869245C8950F966E92D8576A8BA88D21E9 \
	&& echo deb https://get.docker.com/ubuntu docker main > /etc/apt/sources.list.d/docker.list \
	&& apt-get update && apt-get install -y lxc-docker-${DOCKER_VERSION} \
	&& rm -rf /var/lib/apt/lists/*

COPY config/openvpn/ /etc/openvpn/
COPY config/services/ /etc/systemd/system/
COPY resin-vars vpn-init /usr/src/app/

RUN systemctl enable resin-supervisor-dind
