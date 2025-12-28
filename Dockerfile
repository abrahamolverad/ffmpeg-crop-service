FROM node:18-alpine

WORKDIR /app

# Install ffmpeg + ffprobe
RUN apk add --no-cache ffmpeg

# Install deps (no lockfile needed)
COPY package.json ./
RUN npm install --omit=dev

# Copy app
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
