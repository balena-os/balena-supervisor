FROM resin/rpi-buildstep:stripped
ADD . /app
ADD deploy_key /root/.ssh/id_rsa
ADD known_hosts /root/.ssh/known_hosts
RUN /build/builder
ENTRYPOINT ["/app/entry.sh"]
