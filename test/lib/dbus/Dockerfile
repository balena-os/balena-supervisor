FROM ubuntu:20.04

# Install Systemd
RUN apt-get update && apt-get install -y --no-install-recommends \
        dbus \
    && rm -rf /var/lib/apt/lists/*

COPY dbus.conf /etc/dbus-1/session.d/

ENTRYPOINT ["dbus-run-session", "sleep", "infinity"]
