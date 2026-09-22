# Issue 480 Spec: A Documented Nitely Runner Image

## Background

The OCI backend runs with `--pull=never`, so `NITELY_OCI_IMAGE` must already
exist on the host. Nothing in the repository builds one. An operator wanting to
dogfood the sandbox has to guess what the image needs: which shell, which
toolchain, where caches may be written under a read-only rootfs, and which agent
CLIs to add without baking a credential into a published layer.

## User Stories

- **US-001:** As an operator, I can build a runner image from this repository
  and point `NITELY_OCI_IMAGE` at it on day one.
- **US-002:** As an operator, I can add the agent CLIs I use, at versions I
  choose, without a second Dockerfile.
- **US-003:** As an operator, I can prove the image starts the way Nitely starts
  it before a run depends on it.
- **US-004:** As a security reviewer, I can see that no credential is baked into
  the image and read why that matters.

## Acceptance Scenarios

- **US-001 / SC-001:** `docker/runner/build.sh` builds a `command` image with
  `sh`, `bash`, `git`, `ca-certificates`, Node, and pnpm.
- **US-001 / SC-002:** The image writes every tool cache under `/tmp`, so it
  works read-only with `HOME=/tmp/nitely-home` and `/tmp` on tmpfs.
- **US-002 / SC-001:** `--variant agent --agent-clis "<specs>"` installs those
  npm packages. With no `--agent-clis`, the agent variant installs nothing.
- **US-002 / SC-002:** `--agent-clis` on the `command` variant is rejected.
- **US-003 / SC-001:** `--verify` runs the built image `--read-only`,
  `--network=none`, as an unprivileged uid, with `/tmp` on tmpfs, and checks
  that `sh`, `git`, `bash`, `node`, and `pnpm` resolve.
- **US-003 / SC-002:** `--print` shows the engine argv without running it, and
  an unknown `--variant` exits `64` before touching the engine.
- **US-004 / SC-001:** The `agent` target fails the build when an agent
  credential file is present in the image.
- **US-004 / SC-002:** The README states that image layers are readable by
  anyone who can pull the tag, and points at
  `NITELY_OCI_SECRET_ALLOWLIST` as the run-time path for tokens.

## Functional Requirements

- **FR-001:** Add `docker/runner/Dockerfile` with a `command` target and an
  `agent` target built from it.
- **FR-002:** Relocate `HOME`, `PNPM_HOME`, `XDG_CACHE_HOME`,
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `npm_config_cache` under `/tmp`.
- **FR-003:** Declare no `ENTRYPOINT`. Nitely supplies the argv and already runs
  the container with `--init`.
- **FR-004:** Add `docker/runner/build.sh` with `--variant`, `--tag`,
  `--agent-clis`, `--node-image`, `--pnpm-version`, `--engine`, `--verify`,
  `--print`, and `--help`, each also settable through an environment variable.
- **FR-005:** The build script passes no credential to the engine.
- **FR-006:** Document build, tag, `NITELY_OCI_IMAGE`, allowlist tips, and the
  network allowlist interaction in `docker/runner/README.md` and summarize it in
  the main README's OCI section.
- **FR-007:** Guard the Dockerfile and the build script with a repository test
  covering variants, cache relocation, credential absence, and the documented
  allowlist notes.

## Non-Functional Requirements

- **NFR-001:** Defaults track this repository: Node 24 base, pnpm from
  `packageManager`.
- **NFR-002:** The build script fails with exit `64` on invalid input before
  invoking the engine.
- **NFR-003:** No credential-shaped literal appears in either file.

## Out Of Scope

- Publishing or hosting an image registry.
- A GitHub Actions workflow. This repository has no CI to extend yet; the
  repository test is the rot guard.
- Baking Nitely itself into the image.

## Assumptions

- Operators build locally with rootless Docker or Podman.
- Agent CLIs are installable from npm.
