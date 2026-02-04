#!/bin/sh
set -e

DATA_DIR=${DATA_DIR:-/app/data}
CONFIG_PATH=${CONFIG_PATH:-$DATA_DIR/config.json}
export DATA_DIR
export CONFIG_PATH

# Persist Caddy data (certs, account, locks)
export CADDY_DATA_DIR=${CADDY_DATA_DIR:-$DATA_DIR/caddy}
# Ensure Caddy uses persistent data dir
export XDG_DATA_HOME=${XDG_DATA_HOME:-$CADDY_DATA_DIR}
# Caddy binary path
export CADDY_BIN=${CADDY_BIN:-/usr/sbin/caddy}

if [ ! -x "$CADDY_BIN" ]; then
  CADDY_BIN=$(command -v caddy || echo "$CADDY_BIN")
  export CADDY_BIN
fi

mkdir -p "$DATA_DIR"
mkdir -p "$CADDY_DATA_DIR"

# Initialize persistent config if missing
if [ ! -f "$CONFIG_PATH" ]; then
  cp /app/config/config.json "$CONFIG_PATH"
fi

# Keep default path in sync for tooling expectations
ln -sf "$CONFIG_PATH" /app/config/config.json

# Persist Caddyfile alongside config
export CADDYFILE_PATH=${CADDYFILE_PATH:-$DATA_DIR/Caddyfile}

# Ensure config exists
if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config not found at $CONFIG_PATH" >&2
  exit 1
fi

# Generate Caddyfile if enabled (server will write on startup)
node /app/src/server.js &
NODE_PID=$!

# Wait briefly for Caddyfile generation (if enabled)
for i in 1 2 3 4 5; do
  if [ -f "$CADDYFILE_PATH" ]; then
    break
  fi
  sleep 0.5
done

if [ -f "$CADDYFILE_PATH" ]; then
  "$CADDY_BIN" run --config "$CADDYFILE_PATH" --adapter caddyfile &
  CADDY_PID=$!
  wait $NODE_PID $CADDY_PID
else
  wait $NODE_PID
fi
