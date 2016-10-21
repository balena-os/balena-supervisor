# Build golang supervisor
FROM debian:jessie

RUN apt-get update \
	&& apt-get install -y \
		build-essential \
		curl \
		rsync \
		upx-ucl \
	&& rm -rf /var/lib/apt/lists/

ENV GOLANG_VERSION 1.6.3
ENV GOLANG_DOWNLOAD_URL https://golang.org/dl/go$GOLANG_VERSION.linux-amd64.tar.gz
ENV GOLANG_DOWNLOAD_SHA256 cdde5e08530c0579255d6153b08fdb3b8e47caabbe717bc7bcd7561275a87aeb

COPY go-${GOLANG_VERSION}-patches /go-${GOLANG_VERSION}-patches

RUN mkdir /usr/src/go \
	&& cd /usr/src/go \
	&& curl -L -o go.tar.gz $GOLANG_DOWNLOAD_URL \
	&& echo "${GOLANG_DOWNLOAD_SHA256}  go.tar.gz" | sha256sum -c - \
	&& tar xzf go.tar.gz -C /usr/local \
	&& cd /usr/src \
	&& rm -rf go \
	&& export GOROOT_BOOTSTRAP=/usr/local/go-bootstrap \
	&& cp -r /usr/local/go /usr/local/go-bootstrap \
	&& cd /usr/local/go/src \
	&& patch -p2 -i /go-${GOLANG_VERSION}-patches/0001-Revert-runtime-check-and-fail-early-with-a-message-i.patch \
	&& patch -p2 -i /go-${GOLANG_VERSION}-patches/0002-implement-atomic-quadword-ops-with-FILD-FISTP.patch \
	&& ./make.bash \
	&& rm -rf /usr/local/go-bootstrap

ENV GOPATH /go
ENV PATH $GOPATH/bin:/usr/local/go/bin:$PATH

COPY . /go/src/resin-supervisor/gosuper

WORKDIR /go/src/resin-supervisor/gosuper

ENV GOOS linux
ENV GO386=387

ARG GOARCH=amd64
ARG GOARM=''

RUN go install -a -v ./gosuper \
	&& cd /go/bin \
	&& find -type f -name gosuper -exec mv {} /go/bin/gosuper \; \
	&& upx --best /go/bin/gosuper

CMD rsync -a --delete /go/bin/gosuper /build
