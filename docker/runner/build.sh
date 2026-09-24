#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: docker/runner/build.sh [options]

Build a Nitely runner image from docker/runner/Dockerfile.

Options:
  --variant NAME     command or agent. Default: command
  --tag REF          Image tag to build. Default: nitely-runner:local
                     (agent variant default: nitely-runner-agent:local)
  --agent-clis LIST  Space-separated npm specifiers installed in the agent
                     variant, e.g. "@openai/codex@latest". Ignored for command.
  --apt LIST         Space-separated Debian packages added to the agent
                     variant, e.g. "chromium" for browser-backed tests.
  --node-image REF   Base image. Default: node:24-bookworm-slim
  --pnpm-version V   pnpm activated through corepack. Default: 11.0.7
  --engine BIN       Container engine. Default: docker
  --verify           After building, run the smoke checks against the image.
  --print            Print the engine argv instead of running it.
  -h, --help         Show this help.

Environment variables with the same names are also supported:
  NITELY_RUNNER_VARIANT, NITELY_RUNNER_TAG, NITELY_RUNNER_AGENT_CLIS, NITELY_RUNNER_APT,
  NITELY_RUNNER_NODE_IMAGE, NITELY_RUNNER_PNPM_VERSION, NITELY_RUNNER_ENGINE

This script never passes a credential to the build. Agent CLIs read their
tokens from the environment at run time; nothing is baked into a layer.
USAGE
}

variant="${NITELY_RUNNER_VARIANT:-command}"
tag="${NITELY_RUNNER_TAG:-}"
agent_clis="${NITELY_RUNNER_AGENT_CLIS:-}"
apt_packages="${NITELY_RUNNER_APT:-}"
node_image="${NITELY_RUNNER_NODE_IMAGE:-node:24-bookworm-slim}"
pnpm_version="${NITELY_RUNNER_PNPM_VERSION:-11.0.7}"
engine="${NITELY_RUNNER_ENGINE:-docker}"
verify=0
print_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)
      variant="${2:?--variant requires a value}"
      shift 2
      ;;
    --tag)
      tag="${2:?--tag requires a value}"
      shift 2
      ;;
    --agent-clis)
      agent_clis="${2:?--agent-clis requires a value}"
      shift 2
      ;;
    --apt)
      apt_packages="${2:?--apt requires a value}"
      shift 2
      ;;
    --node-image)
      node_image="${2:?--node-image requires a value}"
      shift 2
      ;;
    --pnpm-version)
      pnpm_version="${2:?--pnpm-version requires a value}"
      shift 2
      ;;
    --engine)
      engine="${2:?--engine requires a value}"
      shift 2
      ;;
    --verify)
      verify=1
      shift
      ;;
    --print)
      print_only=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if [[ "${variant}" != "command" && "${variant}" != "agent" ]]; then
  echo "invalid --variant ${variant}; expected command or agent" >&2
  exit 64
fi

if [[ -z "${tag}" ]]; then
  if [[ "${variant}" == "agent" ]]; then
    tag="nitely-runner-agent:local"
  else
    tag="nitely-runner:local"
  fi
fi

if [[ "${variant}" == "command" && -n "${apt_packages}" ]]; then
  echo "--apt requires --variant agent" >&2
  exit 2
fi
if [[ "${variant}" == "command" && -n "${agent_clis}" ]]; then
  echo "--agent-clis requires --variant agent" >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_args=(
  build
  --file "${script_dir}/Dockerfile"
  --target "${variant}"
  --tag "${tag}"
  --build-arg "NODE_IMAGE=${node_image}"
  --build-arg "PNPM_VERSION=${pnpm_version}"
)
if [[ "${variant}" == "agent" ]]; then
  build_args+=(--build-arg "AGENT_CLIS=${agent_clis}")
  build_args+=(--build-arg "EXTRA_APT_PACKAGES=${apt_packages}")
fi
build_args+=("${script_dir}")

if [[ "${print_only}" -eq 1 ]]; then
  printf '%s' "${engine}"
  printf ' %q' "${build_args[@]}"
  printf '\n'
  exit 0
fi

"${engine}" "${build_args[@]}"

if [[ "${verify}" -eq 1 ]]; then
  # Run the checks the way Nitely runs the image: read-only, no network, an
  # unprivileged uid, and /tmp on tmpfs.
  "${engine}" run --rm --read-only --network=none \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --env HOME=/tmp/nitely-home \
    "${tag}" \
    sh -lc 'set -eux; mkdir -p "$HOME"; command -v sh; command -v git; command -v bash; node --version; pnpm --version'
fi

echo "built ${tag} (variant ${variant})"
