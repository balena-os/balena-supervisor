FROM resin/supervisor-base:latest
ADD . /app
RUN /build/builder
