#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME=${1:-aoai-proxy:latest}
BUILD_EPOCH=$(date -u +%s)
BUILD_VERSION=${AOAI_PROXY_VERSION:-nextgen-$(date -u -d "@$BUILD_EPOCH" +%Y%m%d%H%M)}
BUILD_TIME=${AOAI_PROXY_BUILD_TIME:-$(date -u -d "@$BUILD_EPOCH" +%Y-%m-%dT%H:%M:%SZ)}

docker build --pull \
	--build-arg "AOAI_PROXY_VERSION=$BUILD_VERSION" \
	--build-arg "AOAI_PROXY_BUILD_TIME=$BUILD_TIME" \
	-t "$IMAGE_NAME" .
echo "Built $IMAGE_NAME"
echo "Version $BUILD_VERSION, built $BUILD_TIME"
