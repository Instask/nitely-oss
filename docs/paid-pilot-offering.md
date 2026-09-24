# Paid Pilot Offering

Status: first commercial package for #95.

Nitely's first paid offer is a high-touch implementation pilot, not self-serve
SaaS. We turn recurring specs, bugs, and review feedback into customer-hosted AI
workflows that end in reviewable PRs. The pilot sells a narrow repeatable PR
workflow with declared contracts and durable evidence, not a broad software
factory or Agent-workforce platform.

## Offer

**Price:** $2k-$5k/month.

**Duration:** 4-6 weeks, renewable month to month only when the pilot is
creating reviewable PRs or producing concrete workflow learnings.

**Target:** first 3-5 teams that already use AI coding tools for real
engineering work and have repeated tasks that fail to become reliable PRs.
Use [customer-validation.md](customer-validation.md) to collect the evidence
before treating a segment as qualified.

**Positioning:** Nitely is an open, local-first governed spec-to-PR execution
system that helps teams turn approved engineering work into evidence-backed,
reviewable draft PRs without sending code, secrets, or agent execution to a
Nitely-hosted service by default. It operationalizes Codex, Claude Code, GLM,
and future agents as interchangeable runtimes inside declared customer-hosted
Flows. See [positioning.md](positioning.md) for the reusable copy bank.

**Credential policy:** paid pilots should classify provider credentials as
user-scoped, repo-scoped, org-scoped, env-only, or external-vault-backed before
the first run. See [team-credential-policy.md](team-credential-policy.md).

## Qualification Criteria

A good pilot customer has most of these traits:

- already uses Codex CLI, Claude Code, GLM, or similar tools for production
  engineering work;
- has at least one recurring task family: approved specs, bug tickets,
  dependency/API migrations, security fixes, small refactors, or review
  feedback loops;
- can provide a local repository checkout and a customer-managed environment for
  running Nitely;
- has a technical owner who can review generated PRs within one business day;
- can name the senior-engineer cleanup time currently spent on failed AI coding
  attempts;
- is comfortable starting with 3-5 narrow flows instead of broad autonomous
  engineering.

Disqualify or defer teams that:

- want fully autonomous merging without human review;
- require a hosted control plane before local/customer-hosted execution is
  acceptable;
- cannot provide repository access in a customer-controlled environment;
- do not have repeatable task families;
- mainly want general chatbot assistance rather than PR-producing workflows.

## Included

The pilot includes:

- 3-5 production Nitely flows configured for the customer's repo and workflow;
- customer-hosted execution where code, secrets, worktrees, raw prompts, logs,
  and generated artifacts stay in the customer's environment unless explicitly
  configured otherwise;
- draft PR output with branches, verification output, review artifacts, retry
  history, blocker state, and reflection notes;
- weekly review of run outcomes, failed attempts, blocked stages, and cleanup
  time;
- a written before/after summary of senior-engineer time saved and failure modes
  converted into recoverable workflows;
- one pilot closeout report with continue, expand, or stop recommendation.

The first flow set should usually start from
[pilot-flow-templates.md](pilot-flow-templates.md):

- `pilot-approved-spec-pr`;
- `pilot-bug-ticket-fix-pr`;
- `pilot-pr-review-rework`.

## Excluded

The pilot does not include:

- self-serve SaaS access or guaranteed hosted control-plane availability;
- unrestricted custom agent development;
- fully autonomous merge/deploy decisions;
- customer production credential custody by Nitely;
- enterprise SSO, SCIM, RBAC, compliance exports, or retention guarantees;
- broad migration of every engineering workflow in the customer's organization;
- success promises when customer reviewers do not review PRs or provide run
  feedback.

## Success Metrics

Track these weekly and at closeout:

| Metric | Target signal | Why it matters |
| --- | --- | --- |
| Reviewable PRs created | 5+ pilot PRs or 2+ repeated successful runs of one flow | Shows the flow produces durable engineering output, not demos. |
| Merge rate | 40%+ of generated PRs merged or accepted with small rework | Separates reviewable output from throwaway branches. |
| Senior-engineer cleanup time avoided | 30-60 minutes avoided per successful PR | Ties pilot value to expensive human time. |
| Repeated flow usage | At least one flow used 3+ times | Validates repeatability and packaging. |
| Recoverable failures | 3+ failures end with blocker, retry, reflection, or follow-up evidence instead of abandoned terminal state | Shows Nitely improves recovery, not just happy-path generation. |
| Evidence completeness | Every pilot PR has verification, review, and run evidence links or artifacts | Supports human trust and team adoption. |

## Onboarding Checklist

Use [templates/paid-pilot-onboarding-checklist.md](templates/paid-pilot-onboarding-checklist.md)
as the reusable customer checklist, and use
[customer-hosted-runner-onboarding.md](customer-hosted-runner-onboarding.md) to
generate the setup report before the first run.

Minimum onboarding steps:

- name pilot sponsor, technical owner, and PR reviewers;
- identify 3-5 candidate repeated task families;
- choose the first 1-2 flows to configure;
- confirm local/customer-hosted execution environment;
- confirm repo checkout path, package manager, test commands, and branch policy;
- configure least-privilege GitHub token or GitHub CLI access for draft PRs;
- configure agent CLIs and provider credentials in the customer environment;
- add or confirm `nitely.context.json` for sensitive repos;
- run one dry-run validation on a low-risk task;
- agree on weekly review cadence and closeout date.

## Weekly Operating Rhythm

Each week:

1. Select tasks that match the configured pilot flows.
2. Run Nitely from the customer's environment.
3. Review generated PRs, verification output, blockers, and reflections.
4. Classify failed runs by primary failure point: unclear spec, missing repo
   context, runtime failure, test failure, review evidence, recovery, or trust.
5. Update flow prompts, verification commands, or onboarding notes only when the
   change improves repeatability.
6. Record metrics and customer quotes for the closeout report.

## Pilot Closeout

Closeout has three possible decisions:

### Continue

Continue when at least one flow repeatedly creates reviewable PRs and the
customer wants the same scope for another month.

### Expand

Expand when the first flows work and the next bottleneck is team operation:
multi-repo queues, reviewer assignment, policy, dashboards, retention, or
customer-hosted runner coordination.

### Stop

Stop when the customer lacks repeated task families, generated PRs are not
reviewed, or the main pain is unrelated to turning approved engineering work
into reviewable PRs.

## Feed Team-Control-Plane Requirements

Each pilot should produce a short requirement extract for future team products:

- repeated flow families that customers actually paid to configure;
- metadata needed by managers: PR count, merge rate, cleanup time avoided,
  blocker categories, evidence completeness, cost/context usage;
- policy needs: who can start runs, approve plans, approve rework, or publish
  PRs;
- multi-repo needs: repository onboarding, branch policy, GitHub App scope, and
  reviewer routing;
- runner needs: health, scheduling, retry/resume visibility, upload allow-list,
  and customer-hosted fleet operations;
- retention needs: which evidence summaries must be searchable or exportable
  without uploading source code or raw prompts by default.

Feed these learnings into #99 rather than turning one-off pilot customization
into core product complexity.
