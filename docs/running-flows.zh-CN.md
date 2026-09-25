# 运行 Flow

如何校验、运行并配置 Flow。命令使用 `nitely` CLI（安装见 [README](../README.zh-CN.md#安装)），在 Nitely 要操作的仓库中运行。

## 校验 Flow

```bash
nitely validate flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
```

## 查看 Flow 图

```bash
nitely graph flows/implement-spec-bootstrap.json \
  --external-input spec \
  --external-input tech-design
nitely graph flows/implement-spec-bootstrap.json --format mermaid \
  --external-input spec \
  --external-input tech-design
```

`graph` 打印只读的 artifact 派生 DAG（默认 text；`--format mermaid` 可粘贴到
GitHub；`--format json` 为结构化输出）。Flow 仍以 JSON 编写和编辑，没有可视化
DAG 编辑器。Rework 回边不会出现在图里：投影只覆盖静态的 producer/consumer 关系。

## 运行 Bootstrap Task

bootstrap flow 接收一份 spec 和一份 technical design 作为 local-file 输入：

```bash
nitely run flows/implement-spec-bootstrap.json \
  --repo . \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
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
nitely run-stage flows/implement-spec-bootstrap.json review \
  --dry-run
nitely run-stage flows/implement-spec-bootstrap.json test \
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
nitely ci-repair submit ./ci-failure.json \
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
nitely ci-repair decide <idempotency-key> \
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
nitely run flows/implement-spec-bootstrap-grok.json \
  --repo . \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
```

若要用 Pi 而不是 Codex 跑同一条 bootstrap 路径，使用 Pi 变体。真实运行需要本地
`pi` CLI（通过 Pi CLI 配置 model/provider 鉴权）；该 flow 不设置 `model`，因此
沿用本地 CLI 的默认模型。spec 与 tech-design 输入可以是任意本地文件：

```bash
nitely run flows/implement-spec-bootstrap-pi.json \
  --repo . \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
```

若要用 Claude Code 而不是 Codex 跑同一条 bootstrap 路径，使用 Claude 变体。真实
运行需要本地 `claude` CLI 和 `ANTHROPIC_API_KEY`；该 flow 不设置 `model`，因此
沿用本地 CLI 的默认模型。与 Grok、Pi 变体不同，这个变体完整对齐 Codex 基准：
保留 blocking 的 `review` gate 和末尾的 `reflect` stage。

```bash
nitely run flows/implement-spec-bootstrap-claude.json \
  --repo . \
  --input spec=./spec.md \
  --input tech-design=./tech-design.md
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
[docs/context-delivery-and-usage.md](context-delivery-and-usage.md)。

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
