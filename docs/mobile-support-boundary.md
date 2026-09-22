# Mobile Support Boundary

Status: current support statement for iOS and Android.

Nitely's supported execution target is a desktop or server host running the
local CLI/runtime. Mobile devices can be clients to that host, but they are not
currently supported as Nitely runners.

## Supported

Mobile browser access to a reachable Web Console is supported to the extent the
responsive Web Console UI works on that viewport.

The Web Console may be opened from iOS Safari, Android Chrome, or another modern
mobile browser when:

- the Nitely Web server is already running on a reachable desktop or server;
- network, authentication, and browser security settings allow access;
- the workflow only needs Web Console client actions such as inspecting tasks,
  reviewing runs, approving planning artifacts, or checking provider status.

Nitely execution still runs on the desktop or server host that started the Web
Console. That host owns the `.nitely` state, source checkout, provider
credentials, command environment, and agent runtime processes.

## Not Supported

Native iOS and Android apps are not currently supported.

On-device iOS and Android runners are not supported. Nitely flows depend on host
capabilities that mobile operating systems do not currently provide as a
supported Nitely runtime target:

- Node.js 24 and pnpm;
- Git worktrees and repository filesystem state;
- local agent CLIs such as Codex, Claude, or GLM;
- local provider credentials and command environment;
- durable `.nitely` run state, logs, artifacts, and worktrees.

Do not treat a mobile browser session as moving execution onto the mobile
device. It is only a client for a Nitely server running elsewhere.

## Future Mobile Client Direction

If mobile support expands beyond browser access, the minimum architecture should
be a thin client backed by a server-hosted runner:

- authenticated API access to tasks, approvals, runs, artifacts, and evidence;
- mobile-safe task, session, provider-status, and approval views;
- no dependency on local Git worktrees or agent CLIs on the mobile device;
- explicit server-side policy for what actions a mobile client can trigger;
- audit events that distinguish mobile client actions from runner execution.

A PWA or native client should be tracked as a separate product project before
implementation. Until then, mobile support is limited to browser client access
to an already-running Web Console.
