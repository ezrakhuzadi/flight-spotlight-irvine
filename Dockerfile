FROM --platform=linux/amd64 node:20

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /usr/src/app
USER node

EXPOSE 5050

CMD [ "node", "server.js" ]
