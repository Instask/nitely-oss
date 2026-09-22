# Web Console

本地 Web Console 显示什么、如何启动，以及针对正在运行的 server 的远程 CLI。命令从仓库根目录运行。

在仓库 checkout 中启动本地 console：

```bash
pnpm dev -- web --home . --host 127.0.0.1 --port 4173
```

## 截图导览

下面的截图来自当前 checkout 的本地 Web Console，不包含 credential 或生产数据。

| Tasks 与 Planner Agent | Task 审批与 preflight |
| --- | --- |
| ![Nitely Tasks 和 Planner Agent 表单](assets/screenshots/web-console-tasks.png) | ![Nitely task 详情、审批和 preflight 状态](assets/screenshots/web-console-task-detail.png) |

| Flow catalog | Provider 配置 |
| --- | --- |
| ![Nitely 内置和自定义 Flow](assets/screenshots/web-console-flows.png) | ![Nitely provider 配置页](assets/screenshots/web-console-providers.png) |

Console 以 task/work item 为中心。它会把 task 持久化到 `.nitely/tasks/<task-id>/`，把提交的 spec 和 technical design 文本写成稳定的本地文件，并在 task 列表和详情页直接展示关联 agent session。Session 列表和详情页会展示最新执行状态、stage 进度、change request 链接、branch/worktree metadata、context manifest、context usage、已脱敏的 logs/evidence、review findings，以及可用的 parent/child rework 链接。Context manifest 优先使用 run snapshot 中安全的 fetched input metadata，而不是 raw connector reference；timeline 会保留已知 stage type 和轻量 resume/rework marker。`/runs` 仍是兼容路由，但显示 Sessions 视图；`/runs/<run-id>` 会打开 first-class agent session 详情页，支持 completed、failed、running、interrupted 和 incomplete run。

`/flows` 列出 built-in 和 user-defined Flow；可以从 template 创建 Flow、编辑 JSON、实时执行 schema-aware validation，再从 Flow 启动 work item。`/providers` 只显示 provider 是否已配置，不显示 secret。`/preview` 可以启动 repository-owned dev server，查看 diagnostics、DOM hierarchy、viewport 和截图；截图可作为 visual comparison 或 run evidence。

`/tasks` 上的 **Plan work** 表单会通过 Planner Agent workflow 从 GitHub issue
URL、Jira ticket、external document 或 rough prompt 创建 draft task。进入 task
详情页后，先 approve draft spec，再生成 technical design draft、查看持久化的
open questions、approve technical design，之后才能启动正常的 implementation
run。只要 `specStatus` 或 `techDesignStatus` 尚未为 `approved`，启动 run 都会被
阻止。Web Console、CLI 与 `POST /api/draft-specs` 共用同一套状态流转；intake
契约、source provenance 与 drift 行为见
[docs/planning-intake.md](planning-intake.md)。

External document intake 需要提供 document URL 以及 connector 已抓取的 snapshot
文本，provider revision 可选。Nitely 会把 URL、snapshot 和 content hash 作为
planning baseline 持久化；它不会自己去抓取该文档，也不会存储 provider
credential。用同一个 document URL 再次提交会复用原 task，并在 snapshot 变化时
记录 drift。
GitHub issue intake 会使用 Web Console 中配置的 GitHub provider credential，或
`NITELY_GITHUB_TOKEN` / `GITHUB_TOKEN`；公开 issue 会 fallback 到未认证 fetch。

GitHub webhook activation 默认关闭。它接受新鲜且签名有效的 `issues:labeled`、
配置过的 `issues:assigned`、配置过的 issue mention，以及配置过的 PR review
comment 事件，并要求 repository 显式映射、sender 在 allowlist 中、可选
installation allowlist 通过、trigger 命中配置。`POST /api/github/webhooks` 会先
持久化 delivery 并立即返回 HTTP 202，再异步创建仍需人工批准的 draft task，或
创建 pending 的 same-PR task rework request；它不会自动启动 run。配置时无需把
webhook secret 放在命令行参数中：

```bash
NITELY_GITHUB_WEBHOOK_SECRET='replace-with-the-hook-secret' \
NITELY_GITHUB_WEBHOOK_REPOSITORIES='acme/widgets=acme-widgets' \
NITELY_GITHUB_WEBHOOK_ACTORS='trusted-maintainer,nitely-bot' \
NITELY_GITHUB_WEBHOOK_INSTALLATIONS='123456' \
NITELY_GITHUB_WEBHOOK_LABELS='nitely' \
NITELY_GITHUB_WEBHOOK_ASSIGNEES='nitely-bot' \
NITELY_GITHUB_WEBHOOK_MENTIONS='@nitely' \
NITELY_GITHUB_WEBHOOK_FLOW='flows/implement-spec-bootstrap.json' \
NITELY_GITHUB_WEBHOOK_REWORK_FLOW='flows/rework-pr-bootstrap.json' \
pnpm dev -- web --home . --host 127.0.0.1 --port 4173
```

映射右侧的值是 Repos 页面显示的 repository id；home checkout 会根据自己的
`origin` 以 `<owner>-<repo>` 的形式自动注册。

secret、repository 映射、actor allowlist 和 Flow 必须提供；
`NITELY_GITHUB_WEBHOOK_INSTALLATIONS` 可选；未提供时只跳过 installation-id
检查，repository 映射与 actor allowlist 仍然必须提供且不会退化成 wildcard。
label 默认是 `nitely`。HMAC secret 不落盘。delivery id、规范化 provenance、
不可变 source snapshot 与 queue state 保存在
`.nitely/github-webhooks/`；相同 delivery id 不会启动重复工作。assignment、
mention 和 PR review rework 已支持配置触发；GitHub Checks、App token
exchange/rotation、hosted multi-process leases 和自动启动 run 仍不在这一阶段范围内。
同一 state directory 只能运行一个启用 webhook 的 Web 进程：当前切片还没有
原子 worker claim/lease，因此多个 drain 进程不提供 exactly-once processing。

修改 GitHub provider 或 draft-spec ingestion 行为后，应该 smoke 一次已配置的
dev Web 路径，而不是只依赖当前 shell 的 credential：

```bash
/home/jerry/bin/nitely-dev-web-start
NITELY_SERVER_URL=http://127.0.0.1:4174 \
  pnpm dev -- smoke github-issue-intake \
  --issue https://github.com/Instask/nitely/issues/296
```

如果 issue 需要仓库访问权限，先通过 Web Console 的 provider 设置配置 GitHub
provider。provider 未配置时，该 smoke 会以 skip reason 成功退出；如果 credential
已配置但没有访问权限，它会用与 `POST /api/draft-specs` 相同的可执行 credential
提示失败。命令只输出 issue/task/source metadata，不会打印 token value。

默认情况下，Console 只在 loopback listener 上使用 local compatibility mode。请求会被视为一个合成的
`local` admin 用户；没有 `ownerId` 的旧 task/run 仍然可见；provider 写入仍使用
`.nitely/connections.json`。production 或 non-loopback bind 会拒绝 local mode。

共享 Console 可以开启强制登录：

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-me' \
pnpm dev -- web --home . --host 127.0.0.1 --port 4173 --auth required
```

也可以设置 `NITELY_WEB_AUTH=required`。首次启动时，如果
`.nitely/users/users.json` 为空且提供了 admin 环境变量，Nitely 会创建初始
admin。Required mode 会把用户写入 `.nitely/users/users.json`，session 写入
`.nitely/users/sessions/`，Web Console 保存的 provider credential 写入
`.nitely/users/<user-id>/connections.json`。密码使用 salted `scrypt` hash。
API 只返回 public user 字段和 provider 状态；不会返回 secret value。
首次创建会写入不含 credential 的 `auth.bootstrap` security audit event。
bootstrap 会先持久化私有恢复意图，再依次 durable commit 用户、默认组织和固定 ID
的 audit event，最后才标记完成。启动中断后会自动重放未完成步骤，不需要再次读取
明文密码，也不会重复创建 admin 或 audit event；完成标记只保留 identifier，不保留
password verifier 数据。
Production 和 non-loopback 启动若没有 admin，会在 listen 前失败；首个 admin
应使用显式 credential 做一次性前台 bootstrap，不要把 credential 写入 systemd unit。

non-loopback bind 还必须显式声明 TLS reverse-proxy boundary，并启用 secure cookie，
或使用显式的 insecure test cookie 逃生舱（用于局域网 HTTP dogfood）：

```bash
NITELY_WEB_AUTH=required \
NITELY_WEB_TRUSTED_PROXY=true \
NITELY_WEB_SECURE_COOKIE=true \
pnpm dev -- web --home . --host 0.0.0.0 --port 4173
```

在 trusted-proxy 模式下若走明文局域网 HTTP（例如 `http://0.0.0.0:4173`），
可改设 `NITELY_WEB_INSECURE_TEST_COOKIE=true` 代替 `NITELY_WEB_SECURE_COOKIE=true`。
HTTPS 场景仍应优先使用 secure cookie。

proxy/firewall 必须阻止客户端绕过该边界；当前切片不在 Nitely 内终止 TLS。
`GET /api/readiness` 和 CLI 启动输出会显示 auth、admin、bind、proxy、cookie 和
production 控制状态，但不包含 credential。

通过已登录 Web Console 创建的 task 会带上 `ownerId`，从这些 task 启动的 run
会继承该字段。普通用户只能看到自己的 task、run 和 provider 连接状态。Admin
可以查看 legacy unowned task/run；但在 required mode 下，普通用户默认看不到
这些旧数据。

本地 JSON API 包括：

- `GET /api/tasks`
- `POST /api/tasks`
- `POST /api/draft-specs`
- `GET /api/tasks/:taskId`
- `POST /api/tasks/:taskId/approve-spec`
- `POST /api/tasks/:taskId/draft-tech-design`
- `POST /api/tasks/:taskId/approve-tech-design`
- `POST /api/tasks/:taskId/refresh-source-planning`
- `POST /api/tasks/:taskId/runs`
- `GET /api/scheduler`
- `POST /api/scheduler/run`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/providers`
- `GET /api/session`
- `POST /api/session`
- `DELETE /api/session`

批准生成的 draft spec 会同时更新 task metadata 和持久化 spec Markdown 的
`Status:` 行，然后 draft technical design 才会使用该 artifact。

先把 CLI 连接到正在运行的 Nitely 实例，之后同一台机器上的其他进程可以省略
`--server`：

```bash
NITELY_API_TOKEN='nitely_api_...' pnpm dev -- connect --server http://192.168.50.177:4173
pnpm dev -- whoami
```

当前实例保存在 `$NITELY_CONFIG_DIR/current-instance.json`，否则
`$XDG_CONFIG_HOME/nitely/current-instance.json`，否则
`~/.config/nitely/current-instance.json`。token 只从 `NITELY_API_TOKEN` 读取，
没有 `--token` 参数。`whoami` 只显示 token 是否已配置，不会打印 token。
`nitely disconnect` 会清除已保存的实例。`nitely scheduler` 只有在传入 `--server`
或设置 `NITELY_SERVER_URL` 时才会走远端；已保存实例不会把它切到远端。

除了手工传递 `NITELY_API_TOKEN`，也可以对已经有用户体系的远端 server 直接走
浏览器登录：

```bash
nitely auth login --server https://nitely.example --capability tasks:read --capability runs:start --allow-high-impact
```

CLI 会在 stderr 打印一个 URL 和一个短码，尝试打开浏览器并开始轮询，管理员在
该页面上批准这次请求后，签发的 token 会直接写入已保存的实例文件，全程不会
打印出来。`nitely auth logout` 只会清除本地记录，token 本身在 server 上依然
有效，需要在 Web Console 或用 `nitely mcp token revoke` 主动吊销。运行在
`--auth local` 模式下的 server 不支持浏览器登录，见 [docs/local-mcp.md](local-mcp.md)
中的替代方案。

在选择 Flow 之前，可以先列出所连实例上可用的 Flow：

```bash
pnpm dev -- flow list
pnpm dev -- flow list --server http://192.168.50.177:4173 --json
```

`flow list` 每次调用都会请求 `GET /api/flows`，所以实例上新增、改名或删除的
Flow 会立刻反映出来。每行输出 Flow id、来源（`builtin` 或 `user`）、是否可运行
以及名称。其中的 id 正是 `task create --flow` 接受的值。API token 需要
`tasks:read` capability 才能读取该目录。

也可以只用一个 intake source 创建 draft task，而不必先写好 spec 与 technical
design：

```bash
pnpm dev -- task plan --prompt "Let operators import repositories from a pasted GitHub URL."
pnpm dev -- task plan --issue https://github.com/Instask/nitely/issues/578
pnpm dev -- task plan --jira PLAT-142
pnpm dev -- task plan \
  --document-url https://example.feishu.cn/docx/ABC123 \
  --document-file ./exported-policy.md \
  --document-version rev-42
pnpm dev -- task plan --conversation ./intake.json --title "Repository import"
```

`task plan` POST 到 `POST /api/draft-specs`，即 Web Console **Plan work** 表单使
用的同一个端点，并输出 task id、已持久化的 source provenance、spec 与 technical
design 状态，以及下一步的审批命令。每次调用只接受一个 intake source。
`--document-url` 必须配合 `--document-file` 或 `--document-body`：Nitely 只会存储
并 hash 调用方给出的 snapshot，不会自己去抓取文档。`--conversation` 接受一个
JSON 文件，内容可以是 turns 数组或 `{ "turns": [...] }`，每个 turn 形如
`{ "role": "operator" | "agent", "text": "...", "at": "<ISO time>" }`，这些 turn
会作为 intake history 持久化在 task 上。同一个 source 重复提交时会复用已有
task，并报告 drift，而不是悄悄替换已批准的 baseline。API token 需要
`tasks:write`。

也可以直接从本地 markdown 文件在远端 Nitely server 上创建 task：

```bash
pnpm dev -- task create \
  --server http://192.168.50.177:4173 \
  --title "Implement ordered runtime fallback" \
  --issue https://github.com/Instask/nitely/issues/77 \
  --spec specs/issues/077-runtime-fallback-spec.md \
  --tech-design docs/plans/2026-06-21-runtime-fallback-tech-design.md \
  --flow flows/implement-spec-bootstrap.json
```

`--flow` 的取值请从 `nitely flow list` 中挑选，确保该 Flow 在目标实例上真实存在。
设置 `NITELY_SERVER_URL` 或已保存实例后可以省略 `--server`。该命令会把文件内容
发送到 `POST /api/tasks`，并输出 task id 和 Web Console 的 `/tasks/<task-id>`
URL。如果远端 console 使用了多个 repository，可以通过 `--repo-id <id>` 指定目标
repo。远程命令按 `--server`、`NITELY_SERVER_URL`、已保存实例的顺序解析 server；
当存在 `NITELY_API_TOKEN` 或已保存 token 时，会发送
`Authorization: Bearer <token>`。

也可以不打开 Web Console，直接在 CLI 上走完 Task 的规划审批并启动 Run：

```bash
pnpm dev -- task approve-spec <task-id>
pnpm dev -- task draft-tech-design <task-id>
pnpm dev -- task approve-tech-design <task-id>
pnpm dev -- task start <task-id>
```

`task approve-spec` 和 `task approve-tech-design` 分别 POST 到
`/api/tasks/<task-id>/approve-spec` 和 `/api/tasks/<task-id>/approve-tech-design`，
输出 task id 及其对应产物的状态。`task draft-tech-design` POST 到
`/api/tasks/<task-id>/draft-tech-design`，直接基于已批准的 spec 生成一份贴合仓库
现状的 technical design，无需任何手工准备文件，并输出其 open questions。
`task refresh-source-planning` POST 到
`/api/tasks/<task-id>/refresh-source-planning`，用于对 GitHub issue、Jira ticket
或 external document 已发生变化的 task 重新规划。`task start` POST 到
`/api/tasks/<task-id>/runs`，输出启动的 run id、状态，以及用于跟踪的
`nitely run watch <run-id>` 命令。这些命令都支持 `--json`，原样输出服务端返回的
payload。API token 需要 `spec:approve` 才能做两个审批，需要 `tasks:write` 才能
生成 draft 与 refresh，需要 `runs:start` 才能用 `task start`。

`task start` 不会发送 `override=true`，因此存在 run eligibility blocker 的 Task
会被拒绝而不是强行启动；接受 blocker 仍然是 Web Console 上的决定。本地的
`approvals`、`approve`、`deny`、`questions`、`answer` 与这几个命令无关，它们仍然
按仓库作用域读写本地 event store 中的 Run 内审批闸门。

还可以列出所连实例上已有的 Task 和 Run：

```bash
pnpm dev -- task list
pnpm dev -- run list
pnpm dev -- run list --status running
pnpm dev -- run list --server http://192.168.50.177:4173 --json
```

`task list` 调用 `GET /api/tasks`，输出 task id、显示状态和标题；`run list` 调用
`GET /api/runs`，输出 run id、状态、task id 和当前 stage，服务端没有提供的字段
显示为 `-`。`--status <status>` 只保留匹配的 Run，可选值为 `running`、
`completed`、`failed`、`blocked`、`interrupted`、`cancelled`。`--json` 原样输出
服务端返回的数组。API token 需要 `tasks:read` 才能用 `task list`，需要
`runs:read` 才能用 `run list`。两个命令输出的 id 可以直接传给 `task watch` 或
`run watch`。本地的 `nitely runs` 和 `nitely status` 行为不变，仍然读取
`--repo` 指定的仓库。

也可以从任意本地 repo 触发远端 Nitely scheduler 跑一轮：

```bash
NITELY_SERVER_URL=http://192.168.50.177:4173 pnpm dev -- scheduler --once
# 或
pnpm dev -- scheduler --server http://192.168.50.177:4173 --once
```

也可以在本地时间处于指定窗口内时连续触发 scheduler：

```bash
pnpm dev -- scheduler --server http://192.168.50.177:4173 \
  --window 22:00-06:00 --interval-ms 60000
```

使用 `--max-cycles <n>` 可以做有边界的 rehearsal 或 canary run。

该命令会调用 `POST /api/scheduler/run`，并输出与本地 scheduler 相同的 summary。
它的目标是让其他 repo 只通过 HTTP 对接已部署的 Nitely control plane，不需要引入
Nitely 代码。该 endpoint 仅限 admin 使用，因为它会实际启动队列任务并执行配置好的
workflow。

`GET /api/runs` 和 `GET /api/runs/:runId` 会包含面向 Web 的 session
observability 字段：`currentStage`、`currentAttempt`、`currentStageState`、
`latestOutputSummary` 和 `latestDecision`。Run detail timeline item 还包含
明确的 `state`、`currentAttempt`、`latestOutput`、`latestDecision`、attempt
output summary path、attempt `artifact.json` path、stdout/stderr log path 和
generated artifact path。Run detail response 在可用时包含 run-total
`contextUsage`；timeline stage 也会包含由 `stage.context.usage` events 聚合出的
per-stage `contextUsage`。稳定的 stage state 字符串包括 `pending`、`running`、
`gate-checking`、`awaiting-orchestrator`、`retrying`、`reworking`、`escalated`、
`failed`、`completed`、`cancelled` 和 `interrupted`。Output summary 会保持简短，
并使用与持久化 log 相同的 Web redaction。

Provider 设置只展示本地环境变量或 CLI 是否配置。Console 不会要求输入 ChatGPT、Claude、GitHub 或 Google 密码，也不会返回 secret value。
