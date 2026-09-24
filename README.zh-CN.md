# Nitely

[English](./README.md)

Nitely 是一个开源、local-first、受治理的 spec-to-PR 执行系统。它把经过批准的
工程意图转化为有证据支撑、可审查的 draft Pull Request。

版本化 Flow 会声明 input、output、typed artifact、gate、verification 与发布规则。
Nitely 在隔离的 Git worktree 中执行这些契约，并把决策、命令、blocker、恢复与
rework 保留为 review-grade evidence。

Codex、Claude、GLM、Grok Build、Pi 以及未来的 coding agent 都只是 Nitely Flow
可替换的 runtime。Nitely 不是 Agent workforce、chat/inbox 或项目管理套件；它是
从 approved work 到 PR 之间的受治理交付与证据层。

产品 thesis 是：白天规划，夜间执行，早晨审查。背后的 solo founder 与小团队场景见
[docs/usage-scenarios-and-efficiency-thesis.md](docs/usage-scenarios-and-efficiency-thesis.md)。

`Nitely` 目前仅是内部临时代号。在公开 landing page、SaaS control plane、付费
offer 或 package 发布前，必须完成更名与专业商标清查。决策和发布门槛见带日期的
[命名策略](docs/naming-strategy.md)。

项目目前处于 bootstrap 阶段。CLI/runtime 已经存在；本地 Web Console MVP 也已可用，用于创建 task、启动 run、查看 run metadata，以及检查 provider 配置提示。

iOS / Android 支持边界见
[docs/mobile-support-boundary.md](docs/mobile-support-boundary.md)：移动浏览器可以访问已运行且网络可达的 Web Console，但 Nitely 执行仍发生在桌面或服务器主机上；当前不支持原生移动 App 或在移动设备上直接运行 runner。

## 当前状态

`master` 上已经具备：

- JSON flow 加载与校验。
- Local-file 和 Google Drive 输入 connector。
- 每次 run 使用独立 Git worktree。
- `agent`、`command`、`gate`、`approval`、`sync-change`、`publish-change`、`update-change` stage 类型。
- 通过本地 CLI runtime registry 分发 Codex、Claude、GLM、Grok Build 和 Pi agent。
- 失败的 `agent`、`command` 和 `gate` stage 支持有界 retry。
- 发布 GitHub draft PR、更新同仓库 PR 分支、由 operator 扫描 PR comment
  触发 rework，并用 merge 同步 PR 分支。
- 基于 `.nitely/tasks` 和 `.nitely/runs` 的本地 Web Console。
- Web Console 中的 Planner Agent MVP：可从 GitHub issue、Jira ticket 或 prompt
  生成 draft spec，人工 approve spec，再生成并 approve technical design，最后启动实现 run。
- Canonical approval-first ticket-to-PR 产品契约把 ticket intake、规划审批、
  受治理执行、PR review/rework、evidence、指标与信任边界映射到已交付能力和
  可重复验证。见
  [docs/approval-first-ticket-to-pr.md](docs/approval-first-ticket-to-pr.md)。
- 基于持久化 event log 的 run status、logs 和 resume。
- 用 Nitely 实现 Nitely issue 的 bootstrap flows。
- 主确定性 golden-path demo：从 approved task 经过 verification 和 evidence-backed
  draft PR 发布，再处理 reviewer feedback 并受控更新同一个 PR。见
  [docs/golden-path-demo.md](docs/golden-path-demo.md)。
- Buyer-facing 定位明确为受治理的 spec-to-PR 执行系统，而不是 Agent-workforce
  平台；同时定义 GitHub-first 的上游 intake/result contract。见
  [docs/positioning.md](docs/positioning.md) 与
  [docs/upstream-integration-contract.md](docs/upstream-integration-contract.md)。
- canonical 的 trust-and-verification 产品与架构原则：以证据支撑的软件变更、
  独立验证、基于风险的人类注意力和有界恢复。见
  [docs/trust-and-verification-model.md](docs/trust-and-verification-model.md)。
- Flow-defined work item 与 typed artifact：内置 dev 任务是 `dev.pr`
  work item type，非 dev flow 可以声明自己的 `workItemType`，高风险类型由
  allow-list 管控。见 [docs/work-item-model.md](docs/work-item-model.md)。
- 基于实际 diff 的 risk-based review policy：effective risk class 由声明的
  work item baseline 加上确定性 diff 信号（protected path、migration、
  依赖清单、删除、体量、CODEOWNERS）共同得出，连同抬升它的具体信号一起写入
  run evidence，rework 后重新计算，并由仓库策略映射到所需的人工评审。见
  [docs/risk-based-review-policy.md](docs/risk-based-review-policy.md)。
- 静态 multi-perspective review：correctness、security、spec conformance
  三个固定 review gate 独立运行，由 `review-aggregate` gate 把结论合并成
  一个 fail-closed 的决定，然后才允许 publish。见
  [docs/multi-perspective-review.md](docs/multi-perspective-review.md)。
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
- 结构化操作员提问 blocker：agent stage 可通过经过校验的 `question.json`
  暂停运行，操作员可从 CLI 或 Web Console 回答，resume 会把可审计的决策注入下一次 attempt。
- 高级 Approval Inbox 动作与可选通知投递：通知源声明支持的动作及必填原因，
  人工决策写入 task/run evidence，并以持久化 source-key receipt 对 GitHub、
  Jira、Slack、HTTPS 邮件中继和签名 customer webhook 去重。详见
  [docs/notification-actions-and-delivery.md](docs/notification-actions-and-delivery.md)。
- GitHub Webhook intake：签名校验、repository/actor/installation allowlist、持久化
  delivery queue、GitHub Check Run 与 bounded App callback；Webhook 只创建待审批
  task 或 same-PR rework request，不会绕过人工审批自动启动 run。
- Jira ticket intake 与可选 status sync：支持 Cloud browse URL、allow-listed
  self-hosted base URL、Bearer/PAT 和 Cloud Basic auth；同步失败不会丢弃本地 planning task。
- Required Web Console auth：用户、组织、owner-bound API token、session revoke、
  device-flow browser login 和 metadata-only security audit。密码使用 salted `scrypt`
  hash，API 不返回 secret value。详见
  [docs/enterprise-identity-rbac-and-audit.md](docs/enterprise-identity-rbac-and-audit.md)。
- Web Console 中的 Flow catalog、Flow template、实时 schema validation、Preview
  session 和 provider setup；远程 CLI 还支持 `flow list`、`task create`、`task start`、
  `run list/watch` 与 scheduler HTTP 触发。

正在推进 / 计划中：

- 仅在支持受治理执行时扩展超出本地环境变量和 CLI 检查范围的 provider
  connection；provider 数量不是 roadmap 目标。

## 环境要求

- Node.js 24 或更新版本。
- pnpm 11。
- Git。
- 用于发布 GitHub draft PR 和操作 PR comment 的 `NITELY_GITHUB_TOKEN` 或
  `GITHUB_TOKEN`。
- 可选：只有显式使用 `provider: "github-cli"` legacy fallback 时，才需要已登录的 GitHub CLI (`gh`)。
- 根据所使用的 `agent` stage runtime 配置本地 CLI 和凭据。Codex 使用本地
  `codex` CLI 的登录状态；Claude 需要 `ANTHROPIC_API_KEY`；GLM 需要
  `NITELY_GLM_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` 之一；Grok Build
  使用本地 `grok login` 或 `XAI_API_KEY`；Pi 使用本地 Pi CLI/model 配置。

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

## 安装 Nitely Agent Skill

`skills/nitely/` 是一个 agent skill，它把 Nitely 的安装、配置和操作方式（安装路径、
validate → doctor → run → 查看 的主循环、approval / operator question /
usage-limit blocker 的处理、flow JSON 编写、evidence 位置）交给编码 agent。新用户
不必先读完整个 README，可以直接让 agent 帮自己装好并跑起来。

```bash
scripts/install-nitely-skill
```

没有 checkout 时：

```bash
curl -fsSL https://raw.githubusercontent.com/jerryleooo/nitely/master/scripts/install-nitely-skill | bash
```

两者都会把个人 Claude Code skill 安装到
`${CLAUDE_CONFIG_DIR:-~/.claude}/skills/nitely`。`--project [PATH]` 只对单个仓库生效；
`--nitely-repo PATH` 会安装为 Nitely run skill（`PATH/.nitely/skills/nitely`）；
`--dest PATH` 适用于其他 agent 的 skill 目录；`--force` 覆盖已有安装。详见
[docs/nitely-skill.md](docs/nitely-skill.md)。

Skill 改进观察记录在 `.nitely/skill-improvements.db` 中，并且必须经过 operator 确认。
可用 `skill improvements list` 查看，使用 `confirm` 确认 papercut，再用带固定 #429
评测用例的 `propose`，最后通过 `decide` 和 `evaluate` 完成审核。Nitely 不会自动编辑或发布
skill；源内容 hash 变化时会阻止应用。

## 校验 Flow

```bash
node dist/index.js validate flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
```

## 查看 Flow 图

```bash
node dist/index.js graph flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
node dist/index.js graph flows/implement-spec-bootstrap.json --format mermaid \
  --external-input spec \
  --external-input tech-design
```

`graph` 打印只读的 artifact 派生 DAG（默认 text；`--format mermaid` 可粘贴到
GitHub；`--format json` 为结构化输出）。Flow 仍以 JSON 编写和编辑，没有可视化
DAG 编辑器。Rework 回边不会出现在图里：投影只覆盖静态的 producer/consumer 关系。

## 运行 Bootstrap Task

bootstrap flow 接收一份 spec 和一份 technical design 作为 local-file 输入：

```bash
node dist/index.js run flows/implement-spec-bootstrap.json \
  --repo . \
  --input spec=specs/issues/005-run-state-logs-resume-spec.md \
  --input tech-design=docs/plans/2026-06-19-run-state-logs-resume-tech-design.md
```

### 按变更规模选择 flow

启动 run 时选择静态 flow tier；JSON 拓扑保持声明式，不会在运行时自动判断变更规模：

- `flows/implement-small.json` 执行 implement、test、publish，适合低风险变更，跳过高成本 review gate。
- `flows/implement-medium.json` 执行 implement、test、review、publish，适合需要明确质量门禁的变更。

例如：

```bash
nitely run flows/implement-medium.json --repo . \
  --input spec=./spec.md --input tech-design=./tech-design.md
```

只有在 operator 接受较低 review 覆盖率时才使用 small flow；需要 review verdict
阻止发布时使用 medium flow。后续可通过新增静态 JSON 文件扩展 large flow，
不需要给 flow schema 增加条件表达式。

### 运行单个 stage

使用 `run-stage` 可以查看或重放单个 stage，不会执行 flow 的其他 stage：

```bash
node dist/index.js run-stage flows/implement-spec-bootstrap.json review \
  --dry-run
node dist/index.js run-stage flows/implement-spec-bootstrap.json test \
  --repo . --input-dir .nitely/runs/<run-id>/stages/implement/1
```

`--dry-run` 会打印 stage 类型、runtime/model 或 command、输入/输出契约、attempt
预算和将执行的动作，不创建 worktree，也不联系外部 provider。重放时可用
`--input name=path` 提供单个 artifact；`--input-dir` 支持以 artifact id 命名的文件，
或包含 `artifact.json`（其中有 `{ "id", "path" }` output entry）的既有 attempt 目录。
选中的 stage 会基于 `--repo` 创建新的 Nitely worktree；要测试某个 checkout 或
attempt worktree 中的代码，请把它作为 `--repo`。为避免误触外部副作用，publish、
update、sync 和 approval stage 通过此命令只能 dry-run。

### 有界 CI 修复

operator 可以把一次观测到的 GitHub check 失败提交给有界修复循环：

```bash
node dist/index.js ci-repair submit ./ci-failure.json \
  --repo . --flow flows/rework-pr-bootstrap.json \
  --input spec=./spec.md --input tech-design=./tech-design.md
```

该循环只更新现有 pull request，运行仓库声明的本地检查和 flow review gate，
然后观测一次远端 check。提交按 provider/repository/PR/check/head 身份去重，
持久化到 `.nitely/ci-repair.db`；脱敏后的 evidence 也写入
`.nitely/ci-repair/<idempotency-key>.json`。同一观测再次提交时会直接返回已存储
结果，不会再次执行修复。
只有在提交被中断后才使用 `--resume`；它会从已持久化的本地/远端 evidence 继续，
并保留最多两次远端观测的预算。
人工决定可以记录下来，但不会触发 merge 或 deploy：

```bash
node dist/index.js ci-repair decide <idempotency-key> \
  --repo . --decision reject --actor leo --reason "需要人工修复"
```

### local-file `--input` 路径解析

- 相对路径的 `--input` 以 CLI 进程的当前工作目录（`process.cwd()`）为基准解析，
  而不是以 `--repo` 为基准。
- 绝对路径保持不变。
- 解析后的 local-file 路径必须落在目标 `--repo` 目录 **或** 进程 cwd（多仓操作
  时的额外 allow-root）之内。超出这两个 root 的路径会被拒绝，包括逃逸出 root
  的符号链接。
- 因此可以把 spec 放在 Nitely 安装目录旁，同时对另一个 checkout 执行 run，例如：
  `nitely run ... --repo /other/repo --input spec=./local-spec.md`。

若要用 Grok Build 而不是 Codex 跑同一条 bootstrap 路径，使用 Grok 变体。真实
运行需要本地 `grok` CLI（`grok login` 或 `XAI_API_KEY`）；该 flow 不设置
`model`，因此沿用本地 CLI 的默认模型：

```bash
node dist/index.js run flows/implement-spec-bootstrap-grok.json \
  --repo . \
  --input spec=specs/issues/085-grok-bootstrap-flow-spec.md \
  --input tech-design=docs/plans/2026-08-02-grok-bootstrap-flow-tech-design.md
```

若要用 Pi 而不是 Codex 跑同一条 bootstrap 路径，使用 Pi 变体。真实运行需要本地
`pi` CLI（通过 Pi CLI 配置 model/provider 鉴权）；该 flow 不设置 `model`，因此
沿用本地 CLI 的默认模型。spec 与 tech-design 输入可放在 `specs/issues/` 与
`docs/plans/` 下：

```bash
node dist/index.js run flows/implement-spec-bootstrap-pi.json \
  --repo . \
  --input spec=specs/issues/455-pi-bootstrap-flow-spec.md \
  --input tech-design=docs/plans/2026-08-02-pi-bootstrap-flow-tech-design.md
```

若要用 Claude Code 而不是 Codex 跑同一条 bootstrap 路径，使用 Claude 变体。真实
运行需要本地 `claude` CLI 和 `ANTHROPIC_API_KEY`；该 flow 不设置 `model`，因此
沿用本地 CLI 的默认模型。与 Grok、Pi 变体不同，这个变体完整对齐 Codex 基准：
保留 blocking 的 `review` gate 和末尾的 `reflect` stage。

```bash
node dist/index.js run flows/implement-spec-bootstrap-claude.json \
  --repo . \
  --input spec=specs/issues/005-run-state-logs-resume-spec.md \
  --input tech-design=docs/plans/2026-06-19-run-state-logs-resume-tech-design.md
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
- `claude`：运行 `claude -p --output-format json`，prompt 通过 stdin 传入。
  只写 worktree 且 `commands.mode` 为 none 的 stage 会带
  `--permission-mode acceptEdits`；还可能跑命令的 stage 会带
  `--permission-mode bypassPermissions`（对应 Grok 的 `--always-approve`）。
  只读 stage（`write` none 且 `commands` none）保持 Claude `-p` 默认模式。
  禁止写但又允许跑命令的组合会 fail closed，因为 shell 也能改 worktree。
  只把 stage 声明过的 `inputs/<id>` 目录通过 `--add-dir` 加入，这样
  worktree 外的 `fullReadInputs` 可读，又不会放开整个 run input 树。
  需要设置 `ANTHROPIC_API_KEY`。`NITELY_CLAUDE_COMMAND` 可覆盖命令名。
- `glm`：运行 `glm chat`，prompt 通过 stdin 传入。需要设置
  `NITELY_GLM_API_KEY`、`GLM_API_KEY` 或 `ZHIPUAI_API_KEY` 之一。
  `NITELY_GLM_COMMAND` 可覆盖命令名。
- `grok`：运行 `grok --no-auto-update --cwd <worktree> --always-approve`
  并用 `-p <prompt>` 传入 prompt。需要本地 `grok login` 或 `XAI_API_KEY`。
  `NITELY_GROK_COMMAND` 可覆盖命令名。
- `pi`：运行 `pi -p`，prompt 通过 stdin 传入。模型 provider 由本地 Pi CLI
  配置管理。`NITELY_PI_COMMAND` 可覆盖命令名。

可选的 `model` 字段会作为 `-m <model>` 传给 Codex，作为 `--model <model>`
传给 Claude、GLM、Grok Build 和 Pi。未知 runtime 会在启动任何命令前失败；已知
runtime 缺少必需凭据时也会提前给出明确错误。

## Execution Backend 配置

Nitely 默认使用 `local` execution backend：每次 run 创建宿主机 git worktree，
command stage 和 agent CLI 都直接在宿主机执行。

如果目标 repo 声明了项目级 toolchain，可以启用轻量 `mise` backend：

```bash
NITELY_EXECUTION_BACKEND=mise pnpm dev -- web --home . --host 127.0.0.1 --port 4173
nitely run flows/implement-spec-bootstrap.json --repo . --backend mise
```

`mise` backend 会在执行 worktree 中查找 `mise.toml`、`.mise.toml` 或
`.tool-versions`。如果存在 toolchain 文件，它会先为该 workspace 运行一次
`mise install`，再通过 `mise exec -- ...` 执行 command stage 和 agent runtime。
没有 toolchain 文件的 repo 会继续按 local backend 行为执行。这个 backend 不提供
Docker 式强隔离；它只负责声明式 toolchain provisioning，worktree 仍然是宿主机
git worktree。如果 `mise` 命令名或路径不同，可以设置 `NITELY_MISE_COMMAND`。
缺少 `mise` 或 runtime 安装失败时，run 会在 stage 命令执行前给出可操作错误。

`NITELY_EXECUTION_BACKEND=oci` 使用 rootless Docker。聚合 bind-mount 磁盘配额
（`NITELY_OCI_DISK_BYTES`）永久不支持，设置该变量会 fail-closed。请改用按文件的
`NITELY_OCI_MAX_FILE_BYTES` 和捕获输出的 `NITELY_OCI_MAX_CAPTURED_OUTPUT_BYTES`。

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
`claude`、`anthropic`、`glm`、`zhipu`、`grok`、`xai`、`pi`、`codex` 和
`openai`。已知 id 会映射到
Nitely provider，并在对应 provider 未配置时提前失败。`required_connectors`
直接声明 provider id：`google-drive`、`github`、`anthropic`、`glm`、`grok`、
`pi` 或 `codex`。缺失 provider 的错误会包含 stage id、provider id 和
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
  --input spec=specs/issues/022-pr-rework-flow-spec.md \
  --input tech-design=docs/plans/2026-06-19-pr-rework-flow-tech-design.md
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
  --input spec=specs/issues/023-conflict-resolution-flow-spec.md \
  --input tech-design=docs/plans/2026-06-19-conflict-resolution-flow-tech-design.md
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

Run state 会从目标 `--repo` 下持久化的 SQLite event log 投影出来，所以 Nitely
进程退出后仍然可以查看已有 run。默认 `--repo` 是 `.`（进程 cwd）。`run` 结束
（或暂停）时，CLI 会打印可直接复制的多仓 status 提示：

```text
Status command: nitely status <run-id> --repo <absolute-repo-path>
Run directory: <absolute-repo-path>/.nitely/runs/<run-id>
```

```bash
node dist/index.js runs --repo .
node dist/index.js status <run-id> --repo .
node dist/index.js diagnose <run-id> --repo .
node dist/index.js logs <run-id> --repo .
node dist/index.js logs <run-id> --repo . --stage implement
node dist/index.js resume <run-id> --repo .
```

如果 `status` 在当前选定的 repo 下找不到 run，错误信息会提示用 `run` 时的
路径重试 `--repo`。

被 SIGKILL 杀掉的 runner 不会写入任何 terminal event。因此当一个 `running` run
的未结束 attempt 静默超过 stale 阈值时，`status` 会把它报成 `interrupted`，与
Web Console 一致，避免已经死掉的 run 看起来一直在跑。阈值默认 5 分钟，可用
`NITELY_STALE_RUNNING_RUN_MS` 调整。

Run 本身也有上限。每个 run 都受机器级 runaway ceiling 约束，默认 2,000,000
未缓存 runtime token；超出后 run 会失败，并写入 `budget.exceeded` event，记录上限、
已消耗量，以及触发它的 stage 与 attempt。把 `NITELY_DEFAULT_MAX_RUNTIME_TOKENS`
设为其他正整数可以改上限，设为 `0` 则关闭。Flow 不能声明 `spec.budgets`；加载时会
拒绝该字段，并指出用这个环境变量替代。该上限只计非缓存 runtime token：cache read
不计入并单独报告，cache creation 与新增 input 仍按全额计费。预算把 run 停下来之后，
把 `NITELY_DEFAULT_MAX_RUNTIME_TOKENS` 提高到已消耗量之上再 `nitely resume`，会从
第一个未完成的 stage 继续；不提高上限就 resume 会被拒绝并写出已消耗量，而不会在下一次
admission 上再次撞上同一个上限。
详见 [Runaway Ceiling](docs/flow-authoring-guide.md#runaway-ceiling)。

当 agent 没有人类决策就无法安全继续时，可以写入经过校验的 `question.json`。
Nitely 会以 `awaiting_operator_answer` 阻塞，而不会记录失败 attempt。查看并回答后再 resume：

```bash
node dist/index.js questions <run-id> --repo .
node dist/index.js answer <run-id> <question-id> --option <option-id> --actor <name> --repo .
# 或提供自由文本：
node dist/index.js answer <run-id> <question-id> --text "<answer>" --actor <name> --repo .
node dist/index.js resume <run-id> --repo .
```

下一次 attempt 会把问题和回答作为权威 prompt section 注入；两个 event 都会保留在
Web 与 PR evidence 中。

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
pnpm dev -- web --home . --host 127.0.0.1 --port 4173
```

### 截图导览

下面的截图来自当前 checkout 的本地 Web Console，不包含 credential 或生产数据。

| Tasks 与 Planner Agent | Task 审批与 preflight |
| --- | --- |
| ![Nitely Tasks 和 Planner Agent 表单](docs/assets/screenshots/web-console-tasks.png) | ![Nitely task 详情、审批和 preflight 状态](docs/assets/screenshots/web-console-task-detail.png) |

| Flow catalog | Provider 配置 |
| --- | --- |
| ![Nitely 内置和自定义 Flow](docs/assets/screenshots/web-console-flows.png) | ![Nitely provider 配置页](docs/assets/screenshots/web-console-providers.png) |

Console 以 task/work item 为中心。它会把 task 持久化到 `.nitely/tasks/<task-id>/`，把提交的 spec 和 technical design 文本写成稳定的本地文件，并在 task 列表和详情页直接展示关联 agent session。Session 列表和详情页会展示最新执行状态、stage 进度、change request 链接、branch/worktree metadata、context manifest、context usage、已脱敏的 logs/evidence、review findings，以及可用的 parent/child rework 链接。Context manifest 优先使用 run snapshot 中安全的 fetched input metadata，而不是 raw connector reference；timeline 会保留已知 stage type 和轻量 resume/rework marker。`/runs` 仍是兼容路由，但显示 Sessions 视图；`/runs/<run-id>` 会打开 first-class agent session 详情页，支持 completed、failed、running、interrupted 和 incomplete run。

`/flows` 列出 built-in 和 user-defined Flow；可以从 template 创建 Flow、编辑 JSON、实时执行 schema-aware validation，再从 Flow 启动 work item。`/providers` 只显示 provider 是否已配置，不显示 secret。`/preview` 可以启动 repository-owned dev server，查看 diagnostics、DOM hierarchy、viewport 和截图；截图可作为 visual comparison 或 run evidence。

`/tasks` 上的 **Plan work** 表单会通过 Planner Agent workflow 从 GitHub issue
URL、Jira ticket、external document 或 rough prompt 创建 draft task。进入 task
详情页后，先 approve draft spec，再生成 technical design draft、查看持久化的
open questions、approve technical design，之后才能启动正常的 implementation
run。只要 `specStatus` 或 `techDesignStatus` 尚未为 `approved`，启动 run 都会被
阻止。Web Console、CLI 与 `POST /api/draft-specs` 共用同一套状态流转；intake
契约、source provenance 与 drift 行为见
[docs/planning-intake.md](docs/planning-intake.md)。

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
`--auth local` 模式下的 server 不支持浏览器登录，见 [docs/local-mcp.md](docs/local-mcp.md)
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

### Bootstrap model 分层

主 `flows/implement-spec-bootstrap.json` 使用显式 model 分层：测试编写使用
`gpt-5.3-codex-spark`，实现使用 `gpt-5.3-codex`，review gate 使用 `gpt-5`。
这样把便宜工作留给低成本模型，把更贵的模型留给决定质量的 review gate。
这只是普通的 runtime/model 配对，不会扩展 schema，也不会自动路由。

其他 provider 的 flow 可以遵循同一约定，但必须使用该 provider 支持的 model id，
并通过仓库的 runtime capability policy 校验；不要假设不同 provider 的名称可互换。
operator 可以复制 flow 后按自己的账号、policy 和成本边界覆盖这些配对。

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

目标 PR 合并后，从干净的本地 checkout 运行生产部署 helper：

```bash
scripts/nitely-prod-web-deploy
```

该 helper 会在 `jerry@100.96.111.79` 上部署 `/home/jerry/nitely` 的
`origin/master`，构建 checkout，并调用
`/home/jerry/bin/nitely-prod-web-restart`。安装和构建前，它会把生产 Node bin
目录加入 `PATH`。pull 之前，它会报告远端生产 checkout 中 dirty 的 tracked 和
untracked 文件。默认会用命名 stash 保留这些改动，并在 release summary 中打印
stash hash 和实际部署的 commit。需要在远端有本地改动时直接中止，可使用
`--dirty-mode abort`。

生产 Web 也可以交给 user-systemd unit 管理，同时保持同一个部署入口：

```bash
scripts/nitely-prod-web-systemd-install
```

该 installer 会在 `jerry@100.96.111.79` 写入
`~/.config/systemd/user/nitely-web.service`，默认以 required auth 绑定
`127.0.0.1:4173`，
并把 `/home/jerry/bin/nitely-prod-web-restart` 改写为
`systemctl --user restart nitely-web.service` 的轻量 wrapper。安装后继续运行
`scripts/nitely-prod-web-deploy` 即可，restart 会由 systemd 管理，而不是手动
替换 PID。可用 `--print-unit` 在不打开 SSH 的情况下检查 unit 内容；只想安装
unit 和 wrapper 而不立即启动时可用 `--no-start`。
unit 不会写入 admin credential；生产 unit 启动前应显式完成首个 admin bootstrap。
non-loopback `--host` 必须同时传 `--trusted-proxy`，该选项会写入 trusted-proxy
声明并启用 secure cookie。
升级时，installer 只会在可支持解析的有效 auth、bind、proxy、cookie 配置均安全时
保留已有 unit；遇到不安全或无法可靠分类的 unit（包括 drop-in 和 EnvironmentFile）
会保持原文件不变并中止。人工检查后可显式传 `--replace-existing`，installer 会先
备份 unit 和 user drop-in，再安装生成的安全 unit。如果 systemd 报告的 effective
fragment 不同，或 drop-in 位于该 user unit 之外，installer 会拒绝替换，因为它
无法安全消除这类外部配置。

## License

采用 [Apache License 2.0](./LICENSE) 授权，署名信息见 [NOTICE](./NOTICE)。
