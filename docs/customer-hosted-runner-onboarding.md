# Customer-Hosted Runner Onboarding

Status: paid-pilot onboarding package for #232. This document is for pilots that
run Nitely in the customer's environment. The future runner/control-plane design
remains separate in [customer-hosted-runner-boundary.md](customer-hosted-runner-boundary.md).

Use this before the first pilot run to confirm the repository, credentials,
agent runtimes, verification commands, and local evidence boundaries.

## Guided Setup

From the customer repository checkout, run:

```bash
pnpm dev -- pilot setup-report \
  --repo . \
  --flow flows/pilot-approved-spec-pr.json \
  --runtime codex \
  --verify-command "pnpm run check" \
  --verify-command "pnpm run build"
```

For pilots that use multiple agent runtimes, repeat `--runtime`:

```bash
pnpm dev -- pilot setup-report \
  --repo . \
  --flow flows/pilot-pr-review-rework.json \
  --runtime codex \
  --runtime claude \
  --runtime glm \
  --verify-command "pnpm exec vitest run"
```

By default the command writes `.nitely/pilot-setup-report.md`. Use
`--output <path>` when the pilot evidence directory is different. The command
exits non-zero when required setup checks fail, but it still writes the report so
the operator can attach the failure evidence to the pilot notes.

## What The Report Checks

The setup report verifies:

- Node.js, pnpm, and Git availability;
- repository filesystem access and Git checkout detection;
- current branch so the operator can confirm branch policy;
- package manager inference from lockfiles, or an explicit `--package-manager`;
- at least one `--verify-command`;
- GitHub publishing through `NITELY_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `gh auth`;
- requested Codex, Claude, or GLM runtime command and credential readiness;
- `nitely.context.json` presence and parseability;
- local `.nitely` state and retention expectations.

Warnings do not block the pilot, but they should be resolved or explicitly
accepted by the customer owner. Failures block the first run until fixed.

## Credential And Data Boundaries

The customer-hosted runner boundary for paid pilots is:

- source code, worktrees, raw prompts, command logs, provider credentials, and
  generated artifacts stay in the customer environment by default;
- GitHub publishing uses a customer-managed least-privilege token or an
  authenticated GitHub CLI session;
- Codex, Claude, GLM, and future agents run as local customer-managed CLIs;
- `.nitely` state remains local unless the customer explicitly approves selected
  evidence upload;
- any upload of raw logs, prompts, artifacts, or source excerpts must be opt-in
  and visible in the setup report or closeout notes.

This is narrower than the hosted control-plane future. The pilot can use a local
Web Console and local CLI without implying that Nitely operates a multi-tenant
runner fleet for that customer.

## Setup Report Evidence

Attach `.nitely/pilot-setup-report.md` to the pilot evidence before the first
run. The report should answer:

- which repo and flow were checked;
- which verification commands will gate PR output;
- which runtimes were requested and whether their credentials are configured;
- whether GitHub draft PR publishing is ready;
- whether context policy and local retention expectations were reviewed;
- which setup failures or warnings were accepted before proceeding.

Re-run the report whenever credentials, branch policy, flow choice, runtime
choice, verification commands, or context policy changes.

## Operator Checklist

Before the first run:

- choose one of the pilot flow templates;
- confirm the customer repository checkout and base branch;
- create or review `nitely.context.json`;
- configure GitHub publishing credentials in the customer environment;
- configure the requested agent runtime CLIs and credentials;
- run `nitely pilot setup-report`;
- fix every failing check;
- attach the report to the pilot evidence;
- run one low-risk task and review the generated PR evidence with the customer
  technical owner.
