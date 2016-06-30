FROM ubuntu:15.04

# Install the following utilities (required by poky)
RUN apt-get update \
	&& apt-get install -y \
		build-essential \
		chrpath \
		cpio \
		curl \
		diffstat \
		file \
		gawk \
		gcc-multilib \
		git-core \
		libsdl1.2-dev \
		texinfo \
		unzip \
		wget \
		xterm \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/yocto/
