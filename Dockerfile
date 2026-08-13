# syntax=docker/dockerfile:1

ARG NODE_MAJOR=24
ARG CADDY_MAJOR=2

FROM caddy:${CADDY_MAJOR}-alpine AS caddy

FROM node:${NODE_MAJOR}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:${NODE_MAJOR}-alpine AS runtime
WORKDIR /app
ARG AOAI_PROXY_VERSION=unknown
ARG AOAI_PROXY_BUILD_TIME=unknown
ENV NODE_ENV=production
ENV AOAI_PROXY_VERSION=${AOAI_PROXY_VERSION} \
	AOAI_PROXY_BUILD_TIME=${AOAI_PROXY_BUILD_TIME}
LABEL org.opencontainers.image.title="AOAI Proxy" \
	org.opencontainers.image.version=${AOAI_PROXY_VERSION} \
	org.opencontainers.image.created=${AOAI_PROXY_BUILD_TIME}

# App code
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY pricing ./pricing
COPY public ./public
COPY docker/start.sh /app/start.sh
COPY --from=caddy /usr/bin/caddy /usr/sbin/caddy

# Default config inside image (copied to /app/data/config.json on first run)
COPY config/sample_config.json ./config/config.json
ENV CONFIG_PATH=/app/data/config.json

# Persistent data dir (mount a volume to /app/data)
RUN mkdir -p /app/data \
	&& chmod +x /app/start.sh /usr/sbin/caddy

EXPOSE 3000 443
CMD ["/app/start.sh"]
