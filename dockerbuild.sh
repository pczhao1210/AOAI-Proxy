#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${1:-aoai-proxy:minimum-latest}

docker build --pull -t "$IMAGE_NAME" .
echo "Built $IMAGE_NAME"
