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

# Default config inside image (can be overridden by mounting /app/config/config.json)
COPY config/sample_config.json ./config/config.json
ENV CONFIG_PATH=/app/config/config.json

EXPOSE 3000
CMD ["node", "src/server.js"]
