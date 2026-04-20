FROM node:25.8.2-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production
ENV FFMPEG_PATH=ffmpeg
ENV DATABASE_PATH=./data/data.db

CMD ["node", "main.js"]
