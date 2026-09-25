# Nitely

[English](./README.md)

- **Intent is explicit.** 意图必须明确。
- **Execution is constrained.** 执行必须受约束。
- **Results require evidence.** 结果必须有证据。
- **Humans retain authority.** 人保留决定权。

这四句定义产品。每条约束要求什么，见 [docs/product.zh-CN.md](docs/product.zh-CN.md)。
Nitely 是一个开源、local-first、受治理的 spec-to-PR 执行系统。它把经过批准的
工程意图转化为有证据支撑、可审查的 draft Pull Request。

Codex、Claude、GLM、Grok Build、Pi 以及未来的 coding agent 都只是 Nitely Flow
可替换的 runtime。Nitely 不是 Agent workforce、chat/inbox 或项目管理套件；它是
从 approved work 到 PR 之间的受治理交付与证据层。

工作节奏是：白天规划，夜间执行，早晨审查。背后的 solo founder 与小团队场景见
[docs/usage-scenarios-and-efficiency-thesis.md](docs/usage-scenarios-and-efficiency-thesis.md)。

`Nitely` 目前仅是内部临时代号。在公开 landing page、SaaS control plane、付费
offer 或 package 发布前，必须完成更名与专业商标清查。

项目目前处于 bootstrap 阶段。`main` 上已实现的能力见
[docs/status.zh-CN.md](docs/status.zh-CN.md)。Planner 可以从 GitHub issue、Jira ticket 或 prompt
起草 spec。已交付的生命周期见
[docs/approval-first-ticket-to-pr.md](docs/approval-first-ticket-to-pr.md)。

开源核心是可检查的本地 spec-to-PR 执行系统：flow 校验、本地 worktree、本地
agent runtime 分发、context/redaction、日志、evidence、retry/resume 和 draft PR
发布不依赖托管的 Nitely 服务。移动端边界见
[docs/mobile-support-boundary.md](docs/mobile-support-boundary.md)：移动浏览器可以访问已运行且网络可达的 Web Console，但 Nitely 执行仍发生在桌面或服务器主机上；当前不支持原生移动 App 或在移动设备上直接运行 runner。

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

**第一次使用？从 [Quickstart](docs/quickstart.md) 开始**：先离线跑一遍完整流程，
再在自己的仓库上做第一次真实运行（英文）。

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
curl -fsSL https://raw.githubusercontent.com/Instask/nitely-oss/main/scripts/install-nitely-skill | bash
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

## 文档

本文件是入口。操作手册按事情拆开：

- [Quickstart](docs/quickstart.md) — 离线演示，然后第一次真实运行（英文）。
- [产品定义](docs/product.zh-CN.md) — 四条约束和决策检验。
- [当前状态](docs/status.zh-CN.md) — `main` 上已实现的能力。
- [运行 Flow](docs/running-flows.zh-CN.md) — 校验、运行、input、evidence、agent runtime。
- [执行后端](docs/execution-backends.zh-CN.md) — local、mise 和 OCI。
- [返工与恢复](docs/rework-and-recovery.zh-CN.md) — rework、resume 和 retry。
- [Web Console](docs/web-console.zh-CN.md) — 控制台，以及针对正在运行的 server 的远程 CLI。
- [Local MCP server](docs/local-mcp.md)。
- [Flow 格式](docs/flow-format.zh-CN.md) 与 [flow authoring guide](docs/flow-authoring-guide.md)。
- [部署约定](docs/deployment.zh-CN.md)。

## 开发

```bash
pnpm exec vitest run
pnpm run check
pnpm run build
```

## License

采用 [Apache License 2.0](./LICENSE) 授权，署名信息见 [NOTICE](./NOTICE)。
