#!/bin/sh
set -e

NODE_PID=""
CADDY_PID=""

cleanup() {
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "$CADDY_PID" ]; then
    kill "$CADDY_PID" 2>/dev/null || true
  fi
}

trap cleanup TERM INT EXIT

DATA_DIR=${DATA_DIR:-/app/data}
CONFIG_PATH=${CONFIG_PATH:-$DATA_DIR/config.json}
IMAGE_CONFIG_PATH=${IMAGE_CONFIG_PATH:-/app/config/config.json}
export DATA_DIR
export CONFIG_PATH

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

emit_startup_log() {
  level=$1
  event=$2
  shift 2

  printf '{"ts":"%s","source":"startup","level":"%s","event":"%s"' "$(timestamp_utc)" "$level" "$event"
  while [ "$#" -gt 1 ]; do
    key=$1
    value=$2
    shift 2
    printf ',"%s":"%s"' "$key" "$(json_escape "$value")"
  done
  printf '}\n'
}

normalized_persistence_mode() {
  printf '%s' "${PERSISTENCE_MODE:-${CONFIG_PERSISTENCE_MODE:-}}" | tr '[:upper:]' '[:lower:]' | sed 's/[ _-]//g'
}

get_mount_entry() {
  target_path=$1
  awk -v target="$target_path" '
    $5 == target {
      for (i = 1; i <= NF; i++) {
        if ($i == "-") {
          print $5 "|" $(i + 1) "|" $(i + 2)
          exit
        }
      }
    }
  ' /proc/self/mountinfo
}

get_closest_mount_entry() {
  target_path=$1
  awk -v target="$target_path" '
    BEGIN {
      best_len = -1
    }
    {
      mount_point = $5
      if (target == mount_point || index(target, mount_point "/") == 1 || mount_point == "/") {
        current_len = length(mount_point)
        if (current_len > best_len) {
          best_len = current_len
          best_mount = mount_point
          best_fs = ""
          best_source = ""
          for (i = 1; i <= NF; i++) {
            if ($i == "-") {
              best_fs = $(i + 1)
              best_source = $(i + 2)
              break
            }
          }
        }
      }
    }
    END {
      if (best_len >= 0) {
        print best_mount "|" best_fs "|" best_source
      }
    }
  ' /proc/self/mountinfo
}

log_data_mount_diagnostics() {
  requested_mode=$(normalized_persistence_mode)
  [ -n "$requested_mode" ] || requested_mode="unset"

  exact_mount_entry=$(get_mount_entry "$DATA_DIR")
  closest_mount_entry=$(get_closest_mount_entry "$DATA_DIR")

  if [ -n "$exact_mount_entry" ]; then
    mount_point=$(printf '%s' "$exact_mount_entry" | cut -d '|' -f 1)
    fs_type=$(printf '%s' "$exact_mount_entry" | cut -d '|' -f 2)
    mount_source=$(printf '%s' "$exact_mount_entry" | cut -d '|' -f 3)

    emit_startup_log info startup.data_dir_mount_ready \
      dataDir "$DATA_DIR" \
      mountPoint "$mount_point" \
      fsType "$fs_type" \
      mountSource "$mount_source" \
      requestedMode "$requested_mode"
    return
  fi

  closest_mount_point=$(printf '%s' "$closest_mount_entry" | cut -d '|' -f 1)
  closest_fs_type=$(printf '%s' "$closest_mount_entry" | cut -d '|' -f 2)
  closest_mount_source=$(printf '%s' "$closest_mount_entry" | cut -d '|' -f 3)

  emit_startup_log warn startup.data_dir_mount_missing \
    dataDir "$DATA_DIR" \
    requestedMode "$requested_mode" \
    closestMountPoint "$closest_mount_point" \
    closestFsType "$closest_fs_type" \
    closestMountSource "$closest_mount_source"

  case "$requested_mode" in
    azurefile|azurefiles|*+azurefile|azurefile+*)
      emit_startup_log warn startup.azure_files_mount_missing \
        dataDir "$DATA_DIR" \
        requestedMode "$requested_mode" \
        message "Azure Files mount was expected but /app/data is not a separate mount. Persistent files will stay inside the container filesystem."
      ;;
  esac
}

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

log_data_mount_diagnostics

# Initialize persistent config if missing
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -f "$IMAGE_CONFIG_PATH" ]; then
    cp "$IMAGE_CONFIG_PATH" "$CONFIG_PATH"
    echo "Bootstrapped config from $IMAGE_CONFIG_PATH to $CONFIG_PATH"
    echo "Fresh data volume initialized from the image default config. If HTTPS is required, update $CONFIG_PATH to enable server.caddy and set a valid domain/email."
  fi
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
