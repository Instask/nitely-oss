# Nitely Local-First Bootstrap Design

Date: 2026-06-19
Status: Approved direction

## 1. Objective

Build the smallest useful version of Nitely: a local workflow runtime that accepts a specification, runs coding agents and deterministic checks in isolated Git worktrees, and produces a pull request or merge request for human review.

The first milestone is self-hosting:

> Nitely reads a specification for Nitely, modifies its own repository in an isolated worktree, validates the change, and opens a PR/MR without merging it.

The system is local-first and single-user. It preserves boundaries that allow later extraction into self-hosted and multi-tenant deployments, but does not implement those capabilities in the MVP.

## 2. Product Scope

### Included

- CLI commands to start, inspect, resume, and cancel runs.
- Versioned YAML flow definitions.
- Artifact-derived DAG validation and scheduling.
- Codex, Claude, and Pi agent adapters behind one interface.
- Git worktree isolation for each run.
- Append-only run event log.
- Structured stage outputs and artifact manifests.
- Deterministic command gates.
- Bounded retry and rework.
- Human approval before externally visible or destructive actions.
- GitHub pull request and GitLab merge request publishing.
- A built-in self-improvement flow.

### Excluded

- Multi-user authentication.
- Organizations and tenant isolation.
- Billing, quotas, and metering.
- Redis, Kubernetes, and distributed workers.
- A visual DAG editor.
- A skill marketplace.
- Automatic merge.
- Arbitrary production deployment.

## 3. Architecture

Nitely starts as one Node.js application with internal module boundaries:

```text
CLI
 └── Application Service
      ├── Flow Parser and Validator
      ├── Scheduler
      ├── Policy Engine
      ├── Event Store
      ├── Workspace Manager
      ├── Agent Runtime Adapters
      ├── Gate Runner
      └── SCM Adapters
```

The process may execute agent CLIs and gate commands as child processes. These child processes run inside the run worktree and are treated as untrusted execution units.

The application service must not expose implementation details of Codex, Claude, or Pi to the scheduler. Every runtime emits the same normalized event protocol.

## 4. Runtime Boundaries

Even though the MVP is a single process, the following interfaces must remain explicit:

```ts
interface AgentRuntime {
  run(spec: AgentRunSpec): AsyncIterable<AgentEvent>;
  resume?(sessionId: string, input: AgentInput): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
}

interface WorkspaceProvider {
  create(run: RunSpec): Promise<Workspace>;
  snapshot(workspace: Workspace, stageId: string): Promise<ArtifactRef[]>;
  dispose(workspace: Workspace): Promise<void>;
}

interface ScmProvider {
  prepareBranch(input: BranchSpec): Promise<BranchRef>;
  publishChange(input: PublishSpec): Promise<ChangeRequest>;
}
```

These interfaces are the future seams for remote runners, container sandboxes, and additional SCM providers.

## 5. Flow Model

Flows use versioned YAML:

```yaml
apiVersion: nitely.dev/v1alpha1
kind: Flow
metadata:
  name: implement-spec
spec:
  maxAttempts: 2
  stages:
    - id: implement
      type: agent
      runtime: codex
      prompt: Implement the supplied specification.
      inputs: [spec]
      outputs: [implementation]

    - id: test
      type: command
      command: npm test
      inputs: [implementation]
      outputs: [test-report]

    - id: review
      type: agent
      runtime: claude
      prompt: Review the implementation against the specification.
      inputs: [spec, implementation, test-report]
      outputs: [review]

    - id: publish
      type: publish-change
      inputs: [implementation, test-report, review]
```

Dependencies are derived from artifact production and consumption. Manually declared graph edges are not part of the format.

The initial stage types are:

- `agent`
- `command`
- `approval`
- `publish-change`

Additional specialized gate types can be introduced only when their semantics cannot be expressed safely as one of these types.

## 6. Artifact Contract

Each agent stage must produce:

```text
.nitely/stages/<stage-id>/<attempt>/
├── output.md
└── artifacts.json
```

`output.md` is human-readable. `artifacts.json` is machine-readable and validated against a schema.

Example:

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "implementation",
      "kind": "workspace",
      "summary": "Implemented the requested change",
      "path": "."
    }
  ]
}
```

Artifacts are immutable after publication. A retry creates a new attempt; it does not mutate a previous attempt.

## 7. State and Event Model

SQLite is the source of truth. The primary record is an append-only event table:

```text
events(
  sequence,
  run_id,
  stage_id,
  attempt,
  type,
  payload_json,
  created_at
)
```

Important event types:

- `run.created`
- `workspace.created`
- `stage.ready`
- `stage.started`
- `agent.session.started`
- `agent.message.delta`
- `agent.tool.started`
- `agent.tool.completed`
- `artifact.published`
- `gate.completed`
- `stage.completed`
- `stage.failed`
- `stage.retrying`
- `stage.rework.requested`
- `approval.requested`
- `approval.resolved`
- `change.published`
- `run.completed`
- `run.failed`
- `run.cancelled`

Run and stage status tables are projections and may be rebuilt from events. Large logs remain on disk; event payloads contain references rather than unbounded command output.

## 8. Execution and Recovery

The scheduler finds stages whose input artifacts are available. Independent stages may run concurrently later, but the MVP executes one stage at a time to reduce failure modes.

For every stage attempt:

1. Create a fresh attempt directory from the latest accepted workspace snapshot.
2. Assemble bounded context from the flow prompt, stage prompt, and declared artifacts.
3. Execute the agent or command.
4. Validate declared outputs.
5. Run deterministic checks.
6. Accept, retry, request upstream rework, request approval, or fail.
7. Append all decisions to the event log.

On restart, Nitely reconstructs the run state from SQLite. A stage left in `started` state becomes interrupted and requires explicit resume. The MVP does not assume that an arbitrary agent subprocess can survive a Nitely restart.

## 9. Retry, Rework, and Policy

Policy decisions are deterministic:

- `complete`: outputs and gates pass.
- `retry`: rerun the current stage with failure context.
- `rework`: invalidate a named upstream artifact and rerun its producing stage.
- `await-approval`: pause before a protected action.
- `fail`: retry budget is exhausted or the flow is invalid.

Retry and rework limits are mandatory. Oscillation detection prevents two stages from repeatedly invalidating each other.

LLM review may recommend a policy action, but the policy engine validates that recommendation against allowed transitions and budgets.

## 10. Security Model

The MVP is local software running with the current user's authority; it is not a secure multi-tenant sandbox.

It still enforces practical boundaries:

- Every run uses a dedicated Git worktree.
- Agent working directories are restricted to the worktree.
- Secrets are passed only to the adapter or stage that requires them.
- Publishing requires explicit configuration and can require approval.
- Nitely never automatically merges its own PR/MR.
- Nitely never modifies the currently running checkout during self-bootstrap.
- Destructive permission-bypass flags are not the default execution path.
- Command duration and output size are bounded.

Docker-based execution is a later workspace provider, not an MVP prerequisite.

## 11. CLI

Initial commands:

```bash
nitely init
nitely validate <flow>
nitely run <flow> --repo <path> --input <name>=<path>
nitely runs
nitely status <run-id>
nitely logs <run-id> [--stage <stage-id>]
nitely approve <run-id> <approval-id>
nitely resume <run-id>
nitely cancel <run-id>
```

`nitely init` creates `.nitely/config.yaml`, example flows, and an optional `AGENTS.md` template.

## 12. Self-Bootstrap Flow

The Nitely repository contains:

```text
flows/self-improve.yaml
specs/
AGENTS.md
```

A bootstrap run:

```bash
nitely run flows/self-improve.yaml \
  --repo . \
  --input spec=specs/add-feature.md
```

The flow:

1. Validates the specification.
2. Creates an isolated worktree and feature branch.
3. Implements the change with one agent runtime.
4. Runs formatting, type checking, and tests.
5. Reviews the diff with a different runtime when configured.
6. Performs a bounded repair loop.
7. Requires approval before publishing.
8. Opens a draft PR/MR with evidence.

Self-bootstrap success means the PR/MR is reviewable and the current stable Nitely executable remains untouched.

## 13. User Interface Direction

The CLI is the first complete interface. A local Web UI may be added after the bootstrap flow works.

The first UI should expose the existing domain model rather than create a second orchestration model:

- New Run
- Runs
- Run Detail
- Connectors

Run Detail is the priority view: stage timeline, normalized agent events, artifacts, command results, retry/rework decisions, diff, approvals, and final PR/MR.

Flow and skill marketplaces are deferred until reusable flows demonstrate real value.

## 14. Evolution Path

The migration path is:

```text
Local single-user
→ single-tenant self-hosted
→ hosted control plane with customer-hosted runners
→ optional fully managed multi-tenant runners
```

Future-compatible fields such as `workspace_id` may exist internally, but the MVP has one implicit local workspace. Tenant-aware authorization must not be simulated before it is needed.

## 15. Acceptance Criteria

The MVP is complete when:

1. A valid flow can be parsed and its artifact DAG validated.
2. A run can execute in an isolated Git worktree.
3. At least one real agent runtime can modify the repository.
4. Command gates can fail and trigger a bounded retry.
5. Run state survives a Nitely process restart.
6. Artifacts and logs can be inspected through the CLI.
7. A successful run can create a draft GitHub PR or GitLab MR.
8. Nitely can run its self-improvement flow against its own repository.
9. Self-improvement cannot modify or merge into the running checkout automatically.
