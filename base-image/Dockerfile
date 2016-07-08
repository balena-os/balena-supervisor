FROM ubuntu:15.04

# Install the following utilities (required by openembedded)
RUN apt-get update \
	&& apt-get install -y \
		build-essential \
		chrpath \
		cpio \
		curl \
		diffstat \
		file \
		gawk \
		git-core \
		libsdl1.2-dev \
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

COPY build.sh /
CMD bash -ex build.sh
