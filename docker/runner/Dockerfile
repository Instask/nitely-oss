# syntax=docker/dockerfile:1

# Nitely runner image family.
#
# Two targets:
#   command  node + pnpm + git + bash, for offline `command` stages
#   agent    command plus the agent CLIs named by AGENT_CLIS
#
# Nothing here bakes a credential. Agent CLIs read their tokens from the
# environment at run time, and the OCI backend only passes names listed in
# NITELY_OCI_ENV_ALLOWLIST / NITELY_OCI_SECRET_ALLOWLIST. Never add ARG or ENV
# values, COPY a config file, or run a `login` command in this Dockerfile: image
# layers are readable by anyone who can pull the tag.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS command

# Nitely runs this image read-only, as an arbitrary uid, with /tmp on tmpfs and
# HOME=/tmp/nitely-home. Every tool cache therefore has to live under /tmp.
ENV HOME=/tmp/nitely-home \
    PNPM_HOME=/tmp/nitely-home/.local/share/pnpm \
    XDG_CACHE_HOME=/tmp/nitely-home/.cache \
    XDG_CONFIG_HOME=/tmp/nitely-home/.config \
    XDG_DATA_HOME=/tmp/nitely-home/.local/share \
    npm_config_cache=/tmp/nitely-home/.npm \
    npm_config_update_notifier=false \
    CI=true \
    PATH=/tmp/nitely-home/.local/share/pnpm:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

ARG PNPM_VERSION=11.0.7

RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      git \
      openssh-client \
      procps; \
    rm -rf /var/lib/apt/lists/*; \
    corepack enable; \
    # Corepack is told where to keep the activated pnpm instead of being
    # copied out of the build-time HOME afterwards: its default cache moved
    # from $XDG_DATA_HOME/corepack to $XDG_CACHE_HOME/node/corepack (corepack
    # 0.36 in node:24), and pinning COREPACK_HOME makes the image independent
    # of that default. The location is world-readable so a read-only container
    # running as any uid finds it.
    mkdir -p /usr/local/lib/nitely/corepack; \
    COREPACK_HOME=/usr/local/lib/nitely/corepack corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    chmod -R a+rX /usr/local/lib/nitely/corepack; \
    rm -rf /tmp/nitely-home

ENV COREPACK_HOME=/usr/local/lib/nitely/corepack

# Nitely mounts the task worktree here and sets --workdir /workspace itself.
WORKDIR /workspace

# The backend supplies the stage command or the agent argv and already runs the
# container with `--init`, so this image declares no ENTRYPOINT of its own.
# `sh` must exist, because that is what a command stage is executed with.
CMD ["sh"]

FROM command AS agent

# Space-separated npm package specifiers, e.g.
#   --build-arg AGENT_CLIS="@openai/codex@latest @anthropic-ai/claude-code@latest"
# Left empty on purpose: the base agent image installs nothing so an operator
# chooses which runtimes to ship and at which versions.
ARG AGENT_CLIS=""

# Space-separated Debian packages the target repository's verification needs
# beyond the command baseline, e.g. --build-arg EXTRA_APT_PACKAGES="chromium"
# for browser-backed tests (CI runners ship a browser; the slim base does not).
ARG EXTRA_APT_PACKAGES=""

RUN set -eux; \
    if [ -n "${EXTRA_APT_PACKAGES}" ]; then \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${EXTRA_APT_PACKAGES}; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    if [ -n "${AGENT_CLIS}" ]; then \
      npm install --global --no-fund --no-audit ${AGENT_CLIS}; \
    fi; \
    rm -rf /tmp/nitely-home /root/.npm

# A crude but load-bearing check: nothing in the image may look like a baked
# credential file for the agent CLIs.
RUN set -eux; \
    for path in /root/.codex/auth.json /root/.claude.json /root/.config/gh/hosts.yml; do \
      if [ -e "${path}" ]; then \
        echo "refusing to publish an image containing ${path}" >&2; \
        exit 1; \
      fi; \
    done
