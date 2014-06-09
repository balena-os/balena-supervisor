FROM resin/rpi-buildstep:v0.0.7
ADD . /app
RUN /build/builder
