FROM rpi-buildstep-armv6hf:latest
ADD . /app
RUN /build/builder
