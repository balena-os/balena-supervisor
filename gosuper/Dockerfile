# Build golang supervisor
FROM golang:1.6

RUN apt-get update \
	&& apt-get install -y \
		upx-ucl \
		rsync \
	&& rm -rf /var/lib/apt/lists/

COPY . /go/src/resin-supervisor/gosuper

WORKDIR /go/src/resin-supervisor/gosuper

ENV GOOS linux

ARG GOARCH=amd64
ARG GOARM=''

RUN go install -a -v ./gosuper \
	&& cd /go/bin \
	&& find -type f -name gosuper -exec mv {} /go/bin/gosuper \; \
	&& upx --best /go/bin/gosuper

CMD rsync -a /go/bin/gosuper /build
