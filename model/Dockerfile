FROM node:16.13

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY sbvr ./sbvr
COPY index.js ./
COPY wait-for-it.sh ./

RUN apt-get update
