# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# App code
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker/start.sh /app/start.sh

# Default config inside image (copied to /app/data/config.json on first run)
COPY config/sample_config.json ./config/config.json
ENV CONFIG_PATH=/app/data/config.json

# Persistent data dir (mount a volume to /app/data)
RUN mkdir -p /app/data

RUN apk add --no-cache caddy \
	&& chmod +x /app/start.sh

EXPOSE 3000 443
CMD ["/app/start.sh"]
