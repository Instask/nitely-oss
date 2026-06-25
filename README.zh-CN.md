# Nitely

[English](./README.md)

Nitely 是一个 local-first 的工作流运行时，用来把软件规格说明转化为可审查的 Pull Request。

它读取版本化 flow，快照输入材料，创建隔离的 Git worktree，执行 agent、命令和 gate stage，最后把变更发布成 PR 交给人审查。

项目目前处于 bootstrap 阶段。CLI/runtime 已经存在；本地 Web Console MVP 也已可用，用于创建 task、启动 run、查看 run metadata，以及检查 provider 配置提示。

## Open-Core 边界

Nitely 的开源核心是可检查的本地执行系统：flow schema、本地 runtime、worktree
编排、retry/resume、evidence、logs、redaction，以及本地 Web Console 基础能力。
一个工程师应该可以在本地检查并运行这个核心。

商业层用于让团队可靠地共同运行这个核心：组织工作流、多仓库 dashboard、
GitHub App 集成、托管 coordination、evidence retention/search、policy controls、
SSO、audit logs，以及 customer-hosted runner coordination。

后续 SaaS 和 control-plane 工作应遵循
[docs/open-core-boundary.md](docs/open-core-boundary.md) 中定义的边界。

## 当前状态

`master` 上已经具备：

- JSON flow 加载与校验。
- Local-file 和 Google Drive 输入 connector。
- 每次 run 使用独立 Git worktree。
- `agent`、`command`、`gate`、`approval`、`sync-change`、`publish-change`、`update-change` stage 类型。
- 通过本地 CLI runtime registry 分发 Codex、Claude 和 GLM agent。
- 失败的 `agent`、`command` 和 `gate` stage 支持有界 retry。
- 发布 GitHub draft PR、更新同仓库 PR 分支、由 operator 扫描 PR comment
  触发 rework，并用 merge 同步 PR 分支。
- 基于 `.nitely/tasks` 和 `.nitely/runs` 的本地 Web Console。
- Web Console 中的 Planner Agent MVP：可从 GitHub issue 或 prompt 生成 draft
  spec，人工 approve spec，再生成并 approve technical design，最后启动实现 run。
- 基于持久化 event log 的 run status、logs 和 resume。
- 用 Nitely 实现 Nitely issue 的 bootstrap flows。
- Flow-defined work item 与 typed artifact：内置 dev 任务是 `dev.pr`
  work item type，非 dev flow 可以声明自己的 `workItemType`，高风险类型由
  allow-list 管控。见 [docs/work-item-model.md](docs/work-item-model.md)。
- Web Console 支持 user-defined flows：列出内置和自定义 flow、从模板创建、
  用 schema-aware validation 编辑 JSON，并直接从 flow 启动 work item。自定义
  flow 存在本地数据库中，运行时不需要 flow 文件。见
  [docs/user-defined-flows.md](docs/user-defined-flows.md)。
- Flow harness 与 audit evidence 已 enforced：artifact integrity/provenance
  (`sha256`、provenance)、command/approval evidence、required-output 与 JSON
  schema validation、stage-level high-risk gating，以及 run evidence timeline。
  见 [docs/harness-and-audit.md](docs/harness-and-audit.md)。
- 面向大输入的 context 交付优化：小型文本 artifact 会完整 inline，大型文本
  artifact 会给出 preview 和必须读取的完整路径，binary artifact 只给出
  metadata/path。Agent 和 review-gate attempt 会记录
  `stage.context.usage`，Web Console 展示 per-stage 和 run-total context usage。
  见 [docs/context-delivery-and-usage.md](docs/context-delivery-and-usage.md)。
- 可 resume 的 agent usage-limit blocker：provider quota/rate-limit 失败会被投影为
  `agent_usage_limit` blocker，而不是普通 attempt failure；resume 后 run 进入
  terminal 状态时，active blocker banner 会清除。

正在推进 / 计划中：

- 交互式 approval gates。
- 更完整的 PR evidence report。
- 超出本地环境变量和 CLI 检查范围的 provider connection 设置。

## 环境要求

- Node.js 24 或更新版本。
- pnpm 11。
- Git。
- 用于发布 GitHub draft PR 和操作 PR comment 的 `NITELY_GITHUB_TOKEN` 或
  `GITHUB_TOKEN`。
- 可选：只有显式使用 `provider: "github-cli"` legacy fallback 时，才需要已登录的 GitHub CLI (`gh`)。
- 根据所使用的 `agent` stage runtime 配置本地 CLI 和凭据。Codex 使用本地
  `codex` CLI 的登录状态；Claude 需要 `ANTHROPIC_API_KEY`；GLM 需要
  `NITELY_GLM_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` 之一。

## 安装

```bash
pnpm install
pnpm run build
```

从源码运行 CLI：

```bash
pnpm dev -- --help
```

运行构建后的 CLI：

```bash
node dist/index.js --help
```

## 校验 Flow

```bash
node dist/index.js validate flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
```

## 运行 Bootstrap Task

bootstrap flow 接收一份 spec 和一份 technical design 作为 local-file 输入：

```bash
node dist/index.js run flows/implement-spec-bootstrap.json \
  --repo . \
  --input spec=docs/templates/nitely-spec.md \
  --input tech-design=docs/templates/nitely-technical-plan.md
```

Nitely 会：

1. 创建名为 `nitely/<run-id>` 的分支。
2. 在 `.nitely/runs/<run-id>/worktree` 创建 worktree。
3. 把 run、workspace、stage、command、gate、approval、publish 和终态事件写入
   `.nitely/events.db`。
4. 执行 flow 中配置的各个 stage，并按配置的 attempt budget retry 失败的
   agent、command 和 gate stage。
5. 当 publish stage 成功时，push 分支并创建 draft PR。

默认情况下，`publish-change` 使用 Nitely 的 GitHub provider，并通过 GitHub
API 创建 draft PR。请为该 provider 设置 `NITELY_GITHUB_TOKEN`；`GITHUB_TOKEN`
会作为兼容 fallback 被接受。如果 bootstrap 期间需要继续使用旧的 GitHub CLI
路径，请把 publish stage provider 设置为 `github-cli`。

## Context 交付与用量观测

Nitely 会先把每个输入 artifact snapshot 到磁盘，再把适合 prompt 的 compact
视图交给 agent 或 review gate。这个机制是 token/context 优化，不是删除数据：
通过 context policy 接受的完整内容仍保留在 run 目录中的路径上。

- 8 KiB 以内的 textual input 会完整 inline 到 prompt。
- 大于 8 KiB 的 textual input 会以 metadata、可读取的绝对 `Full content`
  路径、8 KiB head preview，以及明确的 mandatory-read 指令表示；agent 使用该
  input 前必须读取完整文件。
- Binary 或 non-textual input 只以 metadata 和路径表示，不 inline 内容。
- 被 `nitely.context.json` policy 省略的 input 会标记为 omitted by policy；
  其字节不会 snapshot，也不会进入 prompt。

大型 input 的完整内容仍在 prompt 中显示的路径上可读。这只是减少 prompt
context，而不是删除 artifact。完整交付表、policy/redaction 关系和 non-goals 见
[docs/context-delivery-and-usage.md](docs/context-delivery-and-usage.md)。

每个 agent 或 review-gate attempt 会记录一个 `stage.context.usage` event，包含：

- `promptBytes`：组装后 prompt 的总字节数。
- `approxTokens`：无 provider 依赖的估算值，`ceil(promptBytes / 4)`。
- `inputBytesInlined`：实际 inline 到 prompt 的 input 字节数。
- `inputBytesSaved`：因 preview 或 path reference 而没有放进 prompt 的 input 字节数。
- `inputCount`：本次 attempt 渲染的 input artifact 数量。

Run projection 会把这些 event 聚合到 attempt、stage 和 run context usage 上。
Web Console run detail 会在存在这些 event 时展示 per-stage context usage 和
run-total context usage；旧 run 没有这些字段时会自然省略。

## Agent Runtime 配置

每个 `agent` stage 都必须声明 `runtime`。Nitely 会 trim 该值，并通过本地
runtime registry 精确解析。当前支持：

- `codex`：运行 `codex exec --sandbox <sandbox> --cd <worktree> -`，prompt
  通过 stdin 传入。`NITELY_CODEX_SANDBOX` 可覆盖 sandbox 值，legacy
  `NIGHTLY_CODEX_SANDBOX` 仍被接受。`NITELY_CODEX_COMMAND` 可覆盖命令名。
- `claude`：运行 `claude -p`，prompt 通过 stdin 传入。需要设置
  `ANTHROPIC_API_KEY`。`NITELY_CLAUDE_COMMAND` 可覆盖命令名。
- `glm`：运行 `glm chat`，prompt 通过 stdin 传入。需要设置
  `NITELY_GLM_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` 之一。
  `NITELY_GLM_COMMAND` 可覆盖命令名。

可选的 `model` 字段会作为 `-m <model>` 传给 Codex，作为 `--model <model>`
传给 Claude/GLM。未知 runtime 会在启动任何命令前失败；已知 runtime 缺少必需凭据时也会提前给出明确错误。

`agent` stage 和 review gate 可以声明启动 agent runtime 前必须可用的 connector：

```json
{
  "id": "implement",
  "type": "agent",
  "runtime": "codex",
  "required_mcp_servers": ["google-drive"],
  "required_connectors": ["github"],
  "prompt": "Implement the supplied specification.",
  "inputs": ["spec"],
  "outputs": ["implementation"]
}
```

`required_mcp_servers` 会保留 MCP server/tool id，例如 `google-drive`、
`google-docs`、`google-sheets`、`google-slides`、`github`、`github-cli`、
`claude`、`anthropic`、`glm`、`zhipu`、`codex` 和 `openai`。已知 id 会映射到
Nitely provider，并在对应 provider 未配置时提前失败。`required_connectors`
直接声明 provider id：`google-drive`、`github`、`anthropic`、`glm` 或
`codex`。缺失 provider 的错误会包含 stage id、provider id 和
`NITELY_GOOGLE_ACCESS_TOKEN` 这类 setup hint。未知 MCP id 只会保留到 run events
中用于观测，不会阻止执行。当前版本只校验已知 provider 是否可用，不会启动 MCP
server。

## Rework 已有 PR

当 review feedback 或后续 spec 需要更新已有 PR 分支，而不是创建新 PR 时，使用
`rework-pr`：

```bash
node dist/index.js rework-pr 22 \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --input spec=docs/templates/nitely-spec.md \
  --input tech-design=docs/templates/nitely-technical-plan.md
```

目标可以是 PR number，也可以是 GitHub PR URL。Nitely 会通过配置的 SCM
provider 解析 PR，拒绝 fork 或跨仓库 head，把 PR head branch checkout 到
`.nitely/runs/<run-id>/worktree` 并停在该分支上，并在最后的 `update-change`
stage 把 commit push 回同一个 PR 分支。Rework flow 必须使用 `update-change`；
如果带 rework target 的 flow 仍包含 `publish-change`，Nitely 会拒绝运行，避免
意外创建第二个 PR。Rework evidence 会记录 PR URL 和 number、base/head branch、
更新前后的 head SHA、触发输入来源、agent runtime/model 声明和已完成 stage。

## 处理 PR Comment

使用 `pr-comments` 可以按需扫描 PR 中显式的 `@nitely` command；第一版不启动
webhook server 或 daemon：

```bash
node dist/index.js pr-comments 22 \
  --repo . \
  --flow flows/rework-pr-bootstrap.json \
  --allow-author trusted-login
```

支持的命令包括 `@nitely rework <instruction>`、`@nitely address this
<instruction>` 和 `@nitely explain <question>`。默认只有 GitHub author
association 为 `OWNER`、`MEMBER` 或 `COLLABORATOR` 的评论会触发 rework；
本地操作时可用 `--allow-author` 增加明确可信的 login。已处理 comment 的 body
hash 会记录在
`.nitely/comment-triggers/github/<owner>/<repo>/<pr-number>/state.json`，避免
重复触发 run。

会产生 rework 的 comment 会在 `.nitely/comment-triggers/.../<comment-id>/`
下生成本地 `spec.md`、`tech-design.md` 和 `trigger.json`，启动同一个 PR 分支上的
rework run，并向 PR 发布包含新 run id 和 evidence path 的简短 comment。
`@nitely explain` 只发布确定性的解释回复，不修改分支。使用 `--dry-run` 可以只查看
计划动作，不创建 run、comment 或 state file。

## 解决 PR 冲突

当已有的同仓库 PR 分支落后于 base branch，或和 base branch 发生冲突时，使用
`resolve-conflicts-bootstrap`：

```bash
node dist/index.js rework-pr <pr> \
  --repo . \
  --flow flows/resolve-conflicts-bootstrap.json \
  --input spec=docs/templates/nitely-spec.md \
  --input tech-design=docs/templates/nitely-technical-plan.md
```

`<pr>` 可以是 PR number，也可以是 GitHub PR URL。第一版的 `sync-change` 只支持
merge 策略：Nitely 会 fetch PR 的 base branch，把它 merge 到已 checkout 的 PR
worktree，写入 `.nitely/runs/<run-id>/stages/sync/1/sync-report.md`，并记录结构化
sync evidence。干净同步会继续执行 verification 和 `update-change`；如果发生冲突，
Git conflict markers 会保留在 worktree 中交给 agent stage 解决。在
`update-change` 之前，verification 会检查 tracked unstaged changes、staged
changes、unmerged index entries，以及 untracked non-ignored files 中残留的
conflict markers。最后的 stage 会更新同一个 PR 分支，不会使用 `publish-change`。
第一版还不支持 rebase continuation。

## 查看并恢复 Run

Run state 会从持久化的 SQLite event log 投影出来，所以 Nitely 进程退出后
仍然可以查看已有 run：

```bash
node dist/index.js runs --repo .
node dist/index.js status <run-id> --repo .
node dist/index.js logs <run-id> --repo .
node dist/index.js logs <run-id> --repo . --stage implement
node dist/index.js resume <run-id> --repo .
```

如果某个 stage 只有 `stage.started` 事件、没有终态 stage 事件，status 会把它
投影为 `interrupted`。`resume` 会先把这个中断 attempt 记录为带有 interruption
context 的失败 attempt，然后在已有 worktree 中启动下一个 attempt。

如果 agent runtime 或 review gate 返回 provider 容量耗尽信息，例如 Codex
`hit your usage limit`、`quota exceeded` 或 rate-limit 文本，Nitely 会把 run
投影为 `blocked`，reason 为 `agent_usage_limit`，而不是继续消耗 retry attempt。
`status` 会显示被阻塞的 stage、runtime、已脱敏的原始 provider message，以及能
提取到的 retry guidance；`logs` 仍会显示该 attempt 捕获到的 stdout/stderr。
当 quota 恢复、凭据修复，或 operator 明确调整 runtime 配置后，运行
`resume <run-id>` 会从 blocked stage 继续，并复用已完成上游 stage 的 artifacts。
Nitely 不会自动购买 quota、刷新凭据，或切换 model/provider。
当 resumed run 完成或失败后，current status 和 Web Console banner 不再显示旧
blocker；被阻塞的 attempt 仍会在 run history 中保留 blocker details。

## Retry 策略

`agent`、`command` 和 `gate` stage 使用有界 retry budget。Nitely 按以下优先级读取
budget：`stage.maxAttempts`、`spec.maxAttempts`，最后默认是 `1`。每次 attempt
都会写入一个不可变目录：

```text
.nitely/runs/<run-id>/stages/<stage-id>/<attempt>/
```

Command attempt 会写入 `stdout.log`、`stderr.log` 和 `output.md`。Agent 和
review-gate attempt 会写入 `prompt.md`、脱敏后的 `stdout.log` /
`stderr.log`、`output.md`、`artifact.json`，并且每个声明的 output 都必须在
同一个 attempt 目录内物化成文件。若 backend 无法捕获 stdout/stderr，Nitely
仍会写入带说明的日志文件。

Agent 成功退出后、stage 标记 completed 或 review gate 通过前，Nitely 会校验
声明 output。缺少 output、`artifact.json` 格式错误、manifest 路径逃逸 attempt
目录、manifest 使用未声明 output id，或选中的 output 文件 trim 后为空，都会使
attempt 失败并进入既有 retry/rework/escalation 策略。未提供 `artifact.json` 时，
Nitely 仍兼容旧约定，按每个 output 的 `<id>.md`、再 `<id>.txt` 发现文件，并在
成功 attempt 中写入合成 manifest。失败后的 agent retry prompt 会包含前一次失败的
上下文，并明确要求不要重复失败方案。当 budget 耗尽时，run 会以清晰的 attempts
exhausted 信息失败。

## Web Console

在仓库 checkout 中启动本地 console：

```bash
pnpm dev -- web --repo . --host 127.0.0.1 --port 4173
```

Console 以 task/work item 为中心。它会把 task 持久化到 `.nitely/tasks/<task-id>/`，把提交的 spec 和 technical design 文本写成稳定的本地文件，并在 task 列表和详情页直接展示关联 agent session。Session 列表和详情页会展示最新执行状态、stage 进度、change request 链接、branch/worktree metadata、context manifest、context usage、已脱敏的 logs/evidence、review findings，以及可用的 parent/child rework 链接。Context manifest 优先使用 run snapshot 中安全的 fetched input metadata，而不是 raw connector reference；timeline 会保留已知 stage type 和轻量 resume/rework marker。`/runs` 仍是兼容路由，但显示 Sessions 视图；`/runs/<run-id>` 会打开 first-class agent session 详情页，支持 completed、failed、running、interrupted 和 incomplete run。

`/tasks` 上的 **Plan work** 表单会通过 Planner Agent workflow 从 GitHub issue
URL 或 rough prompt 创建 draft task。进入 task 详情页后，先 approve draft spec，
再生成 technical design draft、查看持久化的 open questions、approve technical
design，之后才能启动正常的 implementation run。只要 `specStatus` 或
`techDesignStatus` 尚未为 `approved`，启动 run 都会被阻止。

默认情况下，Console 使用 local compatibility mode。请求会被视为一个合成的
`local` admin 用户；没有 `ownerId` 的旧 task/run 仍然可见；provider 写入仍使用
`.nitely/connections.json`。

共享 Console 可以开启强制登录：

```bash
NITELY_ADMIN_EMAIL=admin@example.test \
NITELY_ADMIN_PASSWORD='replace-me' \
pnpm dev -- web --repo . --host 127.0.0.1 --port 4173 --auth required
```

也可以设置 `NITELY_WEB_AUTH=required`。首次启动时，如果
`.nitely/users/users.json` 为空且提供了 admin 环境变量，Nitely 会创建初始
admin。Required mode 会把用户写入 `.nitely/users/users.json`，session 写入
`.nitely/users/sessions/`，Web Console 保存的 provider credential 写入
`.nitely/users/<user-id>/connections.json`。密码使用 salted `scrypt` hash。
API 只返回 public user 字段和 provider 状态；不会返回 secret value。

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
- `POST /api/tasks/:taskId/runs`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/providers`
- `GET /api/session`
- `POST /api/session`
- `DELETE /api/session`

也可以直接从本地 markdown 文件在远端 Nitely server 上创建 task：

```bash
pnpm dev -- task create \
  --server http://127.0.0.1:4173 \
  --title "Implement example feature" \
  --issue https://github.com/Instask/nitely-oss/issues/1 \
  --spec docs/templates/nitely-spec.md \
  --tech-design docs/templates/nitely-technical-plan.md \
  --flow flows/implement-spec-bootstrap.json
```

设置 `NITELY_SERVER_URL` 后可以省略 `--server`。该命令会把文件内容发送到
`POST /api/tasks`，并输出 task id 和 Web Console 的 `/tasks/<task-id>` URL。
如果远端 console 使用了多个 repository，可以通过 `--repo-id <id>` 指定目标
repo。

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

## Flow 格式

Flow 使用 `apiVersion: "nitely.dev/v1alpha1"`，并声明一组 stages：

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "Flow",
  "metadata": {
    "name": "implement-spec-bootstrap"
  },
  "spec": {
    "stages": [
      {
        "id": "implement",
        "type": "agent",
        "runtime": "codex",
        "prompt": "Implement the supplied specification and produce a concise pr-title artifact.",
        "inputs": ["spec"],
        "outputs": ["implementation", "pr-title"]
      },
      {
        "id": "test",
        "type": "gate",
        "mode": "deterministic",
        "command": "pnpm exec vitest run && pnpm run check && pnpm run build",
        "inputs": ["implementation"],
        "outputs": ["test-report"]
      },
      {
        "id": "publish",
        "type": "publish-change",
        "provider": "github",
        "inputs": ["implementation", "test-report", "pr-title"],
        "outputs": ["change-request"]
      }
    ]
  }
}
```

`agent` 阶段可以设置可选的 `model` 来为其 `runtime` 选择模型。省略 `model`
时使用所选 CLI 的默认模型。生成的 PR evidence 会包含 `Agent Runtimes` section，
列出每个 agent stage id、runtime，以及具体 model 或 `default`。

`required_mcp_servers` 和 `required_connectors` 也可以用在 agent stage 和
review gate 上；同一 stage 内的重复 id 会被 flow validation 拒绝。

## 开发

```bash
pnpm exec vitest run
pnpm run check
pnpm run build
```

## 部署约定

server 上的部署目录应始终保持在 `master`。Nitely 生成的分支和 worktree 是用于审查的运行产物，只有对应 PR 合并后才应进入部署 checkout。

## License

采用 [Apache License 2.0](./LICENSE) 授权，署名信息见 [NOTICE](./NOTICE)。
