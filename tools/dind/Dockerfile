FROM debian:jessie

VOLUME /var/lib/docker
VOLUME /resin-data

ENV DEBIAN_FRONTEND noninteractive
ENV TERM xterm
ENV DOCKER_VERSION 1.6.2

COPY ./config/01_nodoc /etc/dpkg/dpkg.cfg.d/
COPY ./config/01_buildconfig /etc/apt/apt.conf.d/

RUN apt-get update \
	&& apt-get dist-upgrade \
	&& apt-get install -y \
		apt-transport-https \
		build-essential \
		ca-certificates \
		curl \
		dbus \
		git \
		htop \
		iptables \
		less \
		libpq-dev \
		libsqlite3-dev \
		jq \
		nano \
		netcat \
		ifupdown \
		openssh-client \
		openssh-server \
		openvpn \
		parted \
		python \
		python-dev \
		rsyslog \
		rsyslog-gnutls \
		socat \
		vim \
		wget \
	&& rm -rf /var/lib/apt/lists/*

ENV CONFD_VERSION 0.10.0

RUN wget -O /usr/local/bin/confd https://github.com/kelseyhightower/confd/releases/download/v${CONFD_VERSION}/confd-${CONFD_VERSION}-linux-amd64 \
	&& chmod a+x /usr/local/bin/confd \
	&& ln -s /usr/src/app/config/confd /etc/confd

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

# systemd configuration

ENV container lxc

# We never want these to run in a container
RUN systemctl mask \
	dev-hugepages.mount \
	dev-mqueue.mount \
	sys-fs-fuse-connections.mount \
	sys-kernel-config.mount \
	sys-kernel-debug.mount \

	display-manager.service \
	getty@.service \
	systemd-logind.service \
	systemd-remount-fs.service \

	getty.target \
	graphical.target

RUN systemctl disable ssh.service

# From get.docker.com script
RUN apt-key adv --keyserver hkp://p80.pool.sks-keyservers.net:80 --recv-keys 36A1D7869245C8950F966E92D8576A8BA88D21E9 \
	&& echo deb https://get.docker.com/ubuntu docker main > /etc/apt/sources.list.d/docker.list \
	&& apt-get update && apt-get install -y lxc-docker-${DOCKER_VERSION} \
	&& rm -rf /var/lib/apt/lists/*

COPY config/openvpn/ /etc/openvpn/
COPY config/services/ /etc/systemd/system/
COPY resin-vars vpn-init /usr/src/app/

RUN systemctl enable resin-supervisor-dind

CMD env > /etc/docker.env; exec /sbin/init