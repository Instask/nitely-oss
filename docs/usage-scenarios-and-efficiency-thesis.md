# Usage Scenarios And Efficiency Thesis

Status: product thesis and demo script package for #220.

Nitely's value is not "AI writes code." The stronger promise is:

> Turn daytime human judgment into an overnight executable engineering queue.

The product loop is:

```text
issue -> conversation -> spec -> tech design -> approval -> scheduled execution -> PR -> review -> deploy -> reflection
```

Use this framing to prioritize plugin planning, approval gates, scheduler
visibility, blocked-run recovery, PR evidence, and demos.

## Solo Founder Scenario

The solo founder or individual developer has more product judgment than
implementation time.

Daytime workflow:

1. Talk to customers, review support notes, triage GitHub issues, or think
   through product ideas.
2. Use a Codex or Claude Code planning workflow to turn the best issue or rough
   idea into a spec and technical design.
3. Let the planning workflow ask only the clarifying questions needed to make
   the work executable.
4. Write approved planning artifacts back into Nitely.
5. Approve the spec and technical design in the Web Console.

Idle/night workflow:

1. Nitely queues the approved task in the scheduler/DAG.
2. Nitely runs implementation, verification, review gates, PR creation, and
   reflection while the user is away.
3. The next morning the user opens the dashboard and sees ready PRs, blocked
   runs, failed checks, and rework prompts.

Core value: convert "I thought this through but do not have time to implement it
now" into an executable queue without losing context.

## Small Team Scenario

The small team has enough people to create work, but coordination and context
switching slow P1-P3 engineering throughput.

Daytime workflow:

1. A PM, founder, support lead, or customer-facing teammate creates or links a
   GitHub issue.
2. The engineering lead uses a planning workflow to create the spec and
   technical design.
3. The lead approves high-risk decisions, sequencing, and non-goals.
4. Nitely records the approved artifacts and dependencies.

Idle/night workflow:

1. Nitely queues dependent work such as data model, API, UI, tests, review, and
   deploy tasks.
2. Runs execute in customer-controlled worktrees with verification and evidence.
3. The next standup centers on the dashboard: ready PRs, blocked tasks, unclear
   requirements, failed runs, deployment status, and rework decisions.

Core value: reduce waiting, status ambiguity, and context switching for
repeatable engineering work.

## Where Efficiency Improves

Nitely should improve:

- issue-to-spec and issue-to-tech-design structuring;
- use of night, idle, or low-interruption time;
- context continuity when resuming planned work;
- visibility into blocked and failed execution states;
- conversion of P2/P3 backlog items into reviewed PRs;
- consistency of pre-PR review, evidence, and reflection artifacts;
- scheduling clarity for dependent work that is too small for heavyweight
  project management but too valuable to leave as chat history.

## Where Efficiency Does Not Automatically Improve

Nitely should not promise automatic improvement when:

- product judgment is vague or unresolved;
- large architecture changes need human design ownership;
- specs are low quality, outdated, or disconnected from repository constraints;
- approval gates are missing or ignored;
- generated PRs are not reviewed by humans;
- the team wants broad autonomous engineering instead of repeatable
  PR-producing workflows.

These cases should become blockers, clarification prompts, or deferred work, not
silent execution.

## Product Priorities

This thesis pushes the roadmap toward:

- planning workflows that turn issues and rough ideas into executable specs;
- Web approval gates for spec, technical design, risky decisions, and rework;
- scheduler and DAG visibility as first-class trust surfaces;
- blocked-run recovery prompts that preserve context;
- PR evidence that explains what ran, what passed, what failed, and what needs
  human attention;
- dashboard views that separate ready PRs, blocked tasks, failed checks, and
  deployment status;
- demo flows that show plan by day, execute by night, review by morning.

These are governed-delivery surfaces, not a path to Agent-workforce or general
project-management breadth. Scheduling executes approved Flows; dashboards
explain PR throughput, evidence, blockers, and recovery; notifications request
specific approvals or actions. Agent profiles, Squads, chat/inbox, board/Gantt
depth, native clients, and provider-count competition remain outside this
roadmap unless customer evidence ties them directly to reviewable PR delivery.

## Solo Founder Demo Script

Goal: show "I found a useful product task today; Nitely made it reviewable by
morning."

Script:

1. Start from a customer quote or GitHub issue with a rough request.
2. Run a planning workflow that asks two clarifying questions.
3. Approve the generated spec and technical design in the Web Console.
4. Show the task entering the scheduler queue with dependencies and verification
   commands.
5. Advance to the completed run: implementation summary, verification output,
   review gate, draft PR, and reflection.
6. Show one blocked variation where missing context becomes a concrete rework
   prompt instead of lost terminal state.

Close with: plan by day, execute by night, review by morning.

## Small Team Demo Script

Goal: show "the team turns approved work into visible PR throughput without
losing control."

Script:

1. Start from a GitHub issue created by a customer-facing teammate.
2. Have the engineering lead approve the spec, technical design, risk notes, and
   first task family.
3. Show the scheduler queue with dependent API, UI, test, and review work.
4. Show the next standup dashboard: ready PRs, blocked runs, failed checks,
   rework prompts, and deployment status.
5. Open a ready PR and show evidence: inputs, run timeline, commands, review
   gate output, artifacts, and reflection.
6. Show a blocked run routed back to the right owner with enough context to make
   a decision.

Close with: plan by day, execute by night, review by morning.
