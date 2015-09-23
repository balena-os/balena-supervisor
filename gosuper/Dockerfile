FROM golang:1.5.1

ENV GOOS linux
ENV GOPATH /usr/src/app

WORKDIR /usr/src/app

COPY . src/resin-supervisor/gosuper

RUN chmod +x src/resin-supervisor/gosuper/build_gosuper.sh
RUN chmod +x src/resin-supervisor/gosuper/test_gosuper.sh
RUN chmod +x src/resin-supervisor/gosuper/test_formatting.sh

# Run go install with -a (force rebuilding of all packages)
# and -v (print package names as they are built)
CMD cd ./src/resin-supervisor/gosuper && ./build_gosuper.sh
