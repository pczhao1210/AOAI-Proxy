#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${1:-aoai-proxy:latest}

docker build -t "$IMAGE_NAME" .
echo "Built $IMAGE_NAME"
