# Customer Validation

Status: interview workflow for #92. This document prepares the validation
system; it does not claim the 5 interviews are complete.

## Goal

Interview 5 teams or agencies already using AI coding tools for production work
and collect concrete examples of AI-generated code that failed to become a
merged or reviewable PR, or required expensive senior-engineer cleanup.

The output feeds:

- #93 positioning: category, target customer, alternatives, proof points;
- #397 competitive boundary: governed execution/evidence versus Agent-workforce
  collaboration and project-management breadth;
- #95 paid pilot package: qualification, success metrics, and pilot scope;
- #99 team-control-plane requirements: dashboards, policies, runner
  coordination, retention, and evidence needs.

## Target Customers

Prioritize:

- AI-heavy agencies or dev shops where PR throughput maps directly to revenue;
- small high-output engineering teams already using Codex CLI, Claude Code, GLM,
  or similar tools;
- teams with approved specs, bug tickets, dependency/API migrations, review
  feedback loops, or recurring engineering chores.

Defer:

- teams only experimenting with chat-based coding;
- teams with no repeated task families;
- teams that require fully autonomous merging before human review;
- teams unwilling to run tools in a customer-controlled environment.

## Discovery Questions

Ask these in every interview:

1. In the last week, how many AI-generated coding attempts did not become merged
   or reviewable PRs?
2. For the latest failed attempt, where did it break: unclear spec, missing repo
   context, runtime failure, test failure, review evidence, recovery, or trust?
3. Who cleaned it up, and how much senior-engineer time did it consume?
4. What artifacts existed at the end: branch, logs, test output, PR, prompt
   history, or nothing durable?
5. Would they pay to turn that class of work into repeatable reviewable PRs?

Follow-up prompts:

- What task family does this failed attempt represent?
- What would have made the output reviewable?
- What would the reviewer need to trust the PR?
- What must stay in your environment?
- Which part is painful enough to pay for this month?

## Failure Classification

Classify each failed attempt by one primary failure point:

| Failure point | Definition | Nitely signal |
| --- | --- | --- |
| Unclear spec | The agent started from ambiguous or incomplete requirements. | Needs spec clarification or planning gate. |
| Missing repo context | The agent lacked files, conventions, or project-specific constraints. | Needs repo index, context policy, or memory file. |
| Runtime failure | Tooling, dependencies, agent CLI, auth, or environment failed. | Needs provider/runtime setup visibility and blocker recovery. |
| Test failure | Code was generated but verification failed or tests were absent. | Needs deterministic verification and failing-test-first flow. |
| Review evidence | A branch existed but reviewers lacked logs, summary, diff rationale, or evidence. | Needs PR evidence report and review gate. |
| Recovery | The attempt stopped midstream and could not be resumed. | Needs retry, resume, rework routing, and reflection. |
| Trust | Code, secrets, prompts, or execution boundaries were not acceptable. | Needs local/customer-hosted execution and explicit data boundary. |

If two points are present, choose the first point that made the attempt
non-reviewable. Record secondary factors separately.

## Interview Notes

Store each interview as:

```text
docs/customer-validation/interviews/YYYY-MM-DD-<company-or-alias>.md
```

Use [templates/customer-discovery-interview.md](templates/customer-discovery-interview.md).

For each failed attempt, capture:

- task family;
- input artifact;
- tool used;
- failure point;
- cleanup owner;
- cleanup time;
- artifacts left behind;
- whether the workflow maps to an existing pilot template;
- buyer willingness to pay;
- exact quotes that explain urgency or risk.

Do not include confidential source code, secrets, customer names, or raw logs
unless the customer explicitly permits that material to be stored in this repo.
Use aliases by default.

## Minimum Evidence Before #93 Or #397

Before closing #93 or #397 positioning, collect at least 3 failed attempts from
these interviews and compare the positioning against them:

- Does "spec-to-PR execution system" describe the pain better than "agent
  runtime"?
- Do the alternatives match what customers currently do?
- Do proof points map to artifacts customers asked for?
- Are there disqualifiers that should be stated earlier?
- Was the primary failure missing governed execution contracts, verification,
  evidence, policy, or recovery—or missing workforce collaboration such as
  chat, routing, and project visibility?
- Does the team want Nitely to replace its planning/workforce system, or to
  consume approved work and return a PR plus evidence?
- Does the customer-controlled data boundary change the buying decision, and
  which source, prompt, tool-output, log, or evidence fields may cross it?

Repository copy and demo tests are not customer evidence. Until three real
failed attempts answer these questions, keep both issues open and report the
dependency rather than inferring validation from internal review.

## Recommendation Template

Write the final recommendation in
`docs/customer-validation/recommendation.md` using
[templates/customer-validation-recommendation.md](templates/customer-validation-recommendation.md).

Recommendation options:

- **Continue:** at least 3 failed attempts share a repeated, expensive failure
  mode that Nitely's local spec-to-PR workflow can address.
- **Narrow:** pain exists, but only for a specific customer type or task family.
- **Pause:** teams are not using AI coding for production PRs, cleanup cost is
  low, or the pain is outside Nitely's scope.

The recommendation must cite interview counts, failed-attempt counts, primary
failure distribution, cleanup time, willingness to pay, and the next paid-pilot
candidate profile.
