FROM node:16-alpine

RUN apk add --update python3 dbus-dev make g++ libgcc

WORKDIR /usr/src/app
COPY package.json *.ts tsconfig.json entry.sh ./

RUN npm install && npm run build

CMD ["./entry.sh"]
