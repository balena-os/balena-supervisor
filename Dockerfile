FROM resin/rpi-buildstep

RUN apt-get update
RUN apt-get install -y -q nodejs npm openvpn

ADD . /supervisor

WORKDIR /supervisor

CMD ["npm", "start"]
