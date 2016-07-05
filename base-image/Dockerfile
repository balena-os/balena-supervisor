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
		sudo \
	&& rm -rf /var/lib/apt/lists/*

RUN useradd -m builder \
	&& mkdir /dest \
	&& chown builder /dest

USER builder

ENV SOURCE_DIR /source
ENV DEST_DIR /dest

COPY build.sh /
CMD bash -ex build.sh
