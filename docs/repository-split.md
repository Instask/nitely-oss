# Nitely Repository Split

Nitely should become open source in layers. The split below keeps the trust
model public while giving the commercial product room to coordinate teams and
hosted operations.

## Repositories

### `nitely-oss`

The inspectable local runtime. This repository owns the behavior a developer
must be able to audit without trusting a hosted service:

- Flow schema, parser, validation, and built-in flow templates.
- Local CLI and Web Console basics.
- Input snapshotting, context delivery, redaction, artifact registry, evidence,
  and run event semantics.
- Local execution backend, agent runtime registry, command/gate/approval stages,
  retry, blocker, resume, rework, and PR publication primitives.
- Provider preflight and local credential handling.
- Runner/control-plane protocol types, metadata upload boundaries, and local
  file-backed contract stubs.
- Public security and trust documentation.

It must remain runnable without a hosted control plane.

### `nitely-runner`

The optional customer-hosted daemon. It should embed or depend on `nitely-oss`
runtime packages, then add the network protocol needed to accept authorized work
from a control plane.

The runner owns host execution concerns: checkout preparation, local credentials,
toolchain availability, run admission, log/artifact streaming, cancellation, and
heartbeat reporting.

### `nitely-control-plane` (private)

The commercial coordination application. Its repository is private; it
consumes the protocol this repository exports under
`nitely/runner-control-plane/*` and must not become a second home for runtime
behavior. It should not execute customer code.
It owns organization workflows: users, repositories, work queues, policy,
approval, runner registration, run scheduling, status projection, evidence
search, and audit.

The control plane coordinates runner work through explicit contracts rather than
reimplementing local runtime behavior.

### `nitely-cloud`

Hosted infrastructure and operations for the control plane. It owns deployment,
environment configuration, secrets wiring, observability, backups, runbooks, and
release automation.

No core runtime behavior should live here.

## Dependency Direction

The intended dependency direction is:

```text
nitely-cloud -> nitely-control-plane -> nitely-runner protocol
                                      -> nitely-oss contracts
nitely-runner -> nitely-oss runtime
```

`nitely-oss` must not depend on the other repositories. `nitely-runner` may use
the OSS runtime, but should keep control-plane communication optional until the
protocol is stable.

## First Extraction Target

The first release target is not a full SaaS split. It is:

1. Make `nitely-oss` buildable, documented, and safe to publish.
2. Publish the runner/control-plane protocol as a local contract stub before
   implementing network execution.
3. Keep hosted deployment work in `nitely-cloud` as runbooks and manifests only.

This reduces the risk of splitting the runtime around a protocol that is still
moving.

## Public API Candidates

The first stable package boundaries should be:

- `flow`: schema, validation, requirements, templates.
- `context`: policy, redaction, context manifests.
- `runtime`: run project model, execution backends, agent runtime registry.
- `evidence`: artifact registry, integrity, run evidence projection.
- `providers`: descriptors and local provider status checks.
- `web-local`: local Web Console server and static assets.
- `runner-protocol`: runner identity, assignment, heartbeat, evidence metadata,
  redaction status, and local file-backed contract tests.

These can stay as internal modules in the first public release. The important
part is documenting which behaviors are contract-bearing before the repository
becomes public.

## Do Not Split Yet

Avoid these splits until real integration pressure exists:

- Moving Web Console basics out of OSS.
- Moving GitHub draft PR publication out of OSS.
- Creating a separate runner package before the run request/heartbeat/artifact
  protocol has been exercised.
- Building cloud-specific adapters into the OSS CLI.
