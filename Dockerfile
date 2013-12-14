# To build the actual image change the source
# image to resin/rpi-raspbian:jessie
FROM tianon/debian:jessie

RUN apt-get update
RUN apt-get install -y -q nodejs npm openvpn

ADD . /supervisor

WORKDIR /supervisor

CMD ["npm", "start"]
