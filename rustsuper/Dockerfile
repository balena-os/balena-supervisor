# Build Rust supervisor
FROM debian:jessie

ENV USER root
ENV DEBIAN_FRONTEND=noninteractive
ENV RUST_INSTALL_SCRIPT=/${USER}/rustup-init.sh
#ENV RUST_VERSION=1.16.0

# Install dependencies
RUN apt-get update && \
	apt-get install -y \
		curl \
		gcc \
		libssl-dev \
		rsync

# Install Rust
RUN curl https://sh.rustup.rs -s -o ${RUST_INSTALL_SCRIPT} && \
	chmod +x ${RUST_INSTALL_SCRIPT} && \
	${RUST_INSTALL_SCRIPT} -y

# Add Cargo binaries to path
ENV PATH /${USER}/.cargo/bin:${PATH}

# Install additional crates
RUN cargo install rustfmt

# Build rustsuper
COPY . /rustsuper
WORKDIR /rustsuper
RUN cargo build --release

# Install rustsuper
CMD rsync -a --delete /rustsuper/target/release/rustsuper /build
