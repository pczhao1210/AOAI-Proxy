#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}")
ROOT_DIR=$(dirname -- "$SCRIPT_PATH")

ACR_LOGIN_SERVER=${ACR_LOGIN_SERVER:-alexmcr.azurecr.io}
IMAGE_REPOSITORY=${IMAGE_REPOSITORY:-aoai-proxy}
DOCKER_PLATFORM=${DOCKER_PLATFORM:-linux/amd64}
BUILDX_BUILDER=${BUILDX_BUILDER:-}
BUILDX_PROGRESS=${BUILDX_PROGRESS:-auto}

case "$DOCKER_PLATFORM" in
	linux/arm64|linux/arm64/v8)
		DEFAULT_IMAGE_TAG=nextgen-latest-arm64
		;;
	*)
		DEFAULT_IMAGE_TAG=nextgen-latest
		;;
esac

IMAGE_TAG=${IMAGE_TAG:-$DEFAULT_IMAGE_TAG}
IMAGE_REF=${IMAGE_REF:-${ACR_LOGIN_SERVER}/${IMAGE_REPOSITORY}:${IMAGE_TAG}}

usage() {
	cat <<'EOF'
Usage:
  ./start.sh build
  ./start.sh --build
  ./start.sh push
  ./start.sh --push
  ./start.sh --build --push

Commands:
  build, --build  Build the image and tag it for ACR.
  push,  --push   Push the existing local image to ACR.

Environment overrides:
ACR_LOGIN_SERVER  Registry login server (default: alexmcr.azurecr.io)
IMAGE_REPOSITORY  Repository name (default: aoai-proxy)
IMAGE_TAG         Image tag (amd64: nextgen-latest; arm64: nextgen-latest-arm64)
IMAGE_REF         Full image reference; overrides the values above
DOCKER_PLATFORM   Build platform (default: linux/amd64)
BUILDX_BUILDER    Optional buildx builder name
BUILDX_PROGRESS   Buildx progress mode (default: auto)
AOAI_PROXY_VERSION     Optional image/application version
AOAI_PROXY_BUILD_TIME  Optional UTC image build timestamp

Push uses credentials already stored by the local Docker CLI. This script never
runs a registry login command and never reads or prints registry credentials.

The selected buildx builder must support every requested platform. Cross-building
arm64 on an amd64 host normally requires a builder with QEMU/binfmt enabled.
EOF
}

fail() {
	printf 'Error: %s\n' "$1" >&2
	exit 1
}

build_image=0
push_image=0

while (($# > 0)); do
	case "$1" in
		build|--build)
			build_image=1
			;;
		push|--push)
			push_image=1
			;;
		-h|--help|help)
			usage
			exit 0
			;;
		*)
			printf 'Unknown argument: %s\n\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
	shift
done

if ((build_image == 0 && push_image == 0)); then
	usage >&2
	exit 2
fi

command -v docker >/dev/null 2>&1 || fail "docker is not installed or not on PATH"
docker info >/dev/null 2>&1 || fail "the Docker daemon is unavailable"

if [[ -z "$IMAGE_REF" || "$IMAGE_REF" =~ [[:space:]] ]]; then
	fail "IMAGE_REF must be a non-empty Docker image reference without whitespace"
fi

if ((build_image == 1)); then
	docker buildx version >/dev/null 2>&1 || fail "docker buildx is unavailable"
	if [[ "$DOCKER_PLATFORM" == *,* && $push_image -eq 0 ]]; then
		fail "multi-platform builds cannot use --load; combine --build with --push"
	fi

	BUILD_EPOCH=$(date -u +%s)
	BUILD_VERSION=${AOAI_PROXY_VERSION:-nextgen-$(date -u -d "@$BUILD_EPOCH" +%Y%m%d%H%M)}
	BUILD_TIME=${AOAI_PROXY_BUILD_TIME:-$(date -u -d "@$BUILD_EPOCH" +%Y-%m-%dT%H:%M:%SZ)}

	buildx_args=(
		--platform "$DOCKER_PLATFORM"
		--progress "$BUILDX_PROGRESS"
		--pull
		--build-arg "AOAI_PROXY_VERSION=$BUILD_VERSION"
		--build-arg "AOAI_PROXY_BUILD_TIME=$BUILD_TIME"
		--tag "$IMAGE_REF"
	)
	if [[ -n "$BUILDX_BUILDER" ]]; then
		buildx_args+=(--builder "$BUILDX_BUILDER")
	fi
	if ((push_image == 1)); then
		buildx_args+=(--push)
	else
		buildx_args+=(--load)
	fi

	printf 'Building %s for %s with docker buildx\n' "$IMAGE_REF" "$DOCKER_PLATFORM"
	docker buildx build "${buildx_args[@]}" "$ROOT_DIR"
	printf 'Version %s, built %s\n' "$BUILD_VERSION" "$BUILD_TIME"

	if ((push_image == 1)); then
		printf 'Built and pushed %s using the local Docker credential store\n' "$IMAGE_REF"
	fi
fi

if ((push_image == 1 && build_image == 0)); then
	docker image inspect "$IMAGE_REF" >/dev/null 2>&1 \
		|| fail "local image $IMAGE_REF does not exist; run ./start.sh --build first"

	printf 'Pushing %s using the local Docker credential store\n' "$IMAGE_REF"
	docker push "$IMAGE_REF"
	printf 'Pushed %s\n' "$IMAGE_REF"
fi