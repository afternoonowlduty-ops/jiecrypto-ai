# jiecrypto.ai — production container
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so Docker caches this layer between deploys.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Generated images are saved here — mount a persistent volume on this path
# in Coolify so they survive redeploys.
RUN mkdir -p /app/generated-media

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
