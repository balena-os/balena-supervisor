FROM resin/supervisor-base:latest
RUN apt-get -q update && apt-get install -qqy openvpn libsqlite3-dev socat
ADD . /app
RUN /build/builder
RUN apt-get clean
