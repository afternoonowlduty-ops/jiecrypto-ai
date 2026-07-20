# Pesles AI — production container

# ---- Build stage: install deps and minify frontend assets ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Production serves minified JS/CSS: smaller, faster, and not human-readable
# in DevTools. index.html is left alone — it's a server-side template and the
# <!--#robots--> placeholder must survive.
RUN npx --yes esbuild@0.25.0 public/app.js --minify --target=es2020 \
      --outfile=public/app.js --allow-overwrite \
 && npx --yes esbuild@0.25.0 public/style.css --minify \
      --outfile=public/style.css --allow-overwrite

# ---- Runtime stage: only what the server needs ----
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/public ./public

# Generated images are saved here — mount a persistent volume on this path
# in Coolify so they survive redeploys.
RUN mkdir -p /app/generated-media

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
