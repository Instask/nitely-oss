# Nitely

[English](README.md)

Nitely 是一个开源、本地优先、受治理的 spec-to-PR 执行系统。它把已经批准的工程意图转成有证据支撑、可审查的 draft Pull Request。Codex、Claude、GLM、Grok Build、Pi 和未来的 coding agent 都只是 Nitely Flow 可互换的运行时；Nitely 不是 Agent workforce、chat/inbox 或项目管理套件。

产品主张是：**白天规划，夜间执行，早晨审查**。

## 快速开始

需要 Node.js 24 和 pnpm 11。

```bash
pnpm install --frozen-lockfile
pnpm dev -- flow validate flows/implement-small.json
pnpm dev -- task plan --prompt "增加健康检查端点"
pnpm dev -- task draft-tech-design <task-id>
```

规划输入可以是 GitHub issue、Jira ticket 或 prompt，也可以是外部文档：

```bash
pnpm dev -- task plan --issue owner/repo#123
pnpm dev -- task plan --jira ENG-123
pnpm dev -- task plan --document-url https://example.feishu.cn/docx/ABC123
```

CLI 会把运行状态写入 `.nitely/`；Web Console 用于审查 Task、审批、Run、evidence 和恢复操作。

## 能做什么

- 从声明过的输入创建规划产物，并在实施前要求明确批准。
- 用版本化 JSON Flow 驱动本地 coding-agent runtime，产出带 evidence 的 draft PR。
- 保留 Task 产物、stage attempt、review feedback、operator decision 和恢复历史。
- 将反馈受控地路由到同一个 PR 的返工，而非静默重跑无关工作。

## 文档导航

README 只保留入口；请直接阅读对应的专题文档。

### 产品与工作流

- [产品定位](docs/positioning.md) 与 [使用场景](docs/usage-scenarios-and-efficiency-thesis.md)
- [批准优先的 ticket-to-PR 合同](docs/approval-first-ticket-to-pr.md)
- [规划输入](docs/planning-intake.md) 与 [规范产物](docs/canonical-artifacts.md)
- [Golden-path 演示](docs/golden-path-demo.md) 与 [试点 Flow 模板](docs/pilot-flow-templates.md)
- [审查门禁与自定义 Flow](docs/user-defined-flows.md)

### 运行 Nitely

- [Flow 编写](docs/flow-authoring-guide.md)、[本地 MCP](docs/local-mcp.md) 与 [项目指令](docs/project-instructions.md)
- [Provider 连接](docs/provider-connections.md)、[定时任务](docs/schedules.md) 与 [OCI 生命周期和恢复](docs/oci-lifecycle-recovery.md)
- [安全与信任](docs/security-and-trust.md)、[evidence 保留](docs/evidence-retention-search-export.md) 与 [上下文交付](docs/context-delivery-and-usage.md)
- [Web 预览运行时](docs/web-preview-runtime.md) 与 [移动端支持边界](docs/mobile-support-boundary.md)

### 边界与上线

- [Open-core 边界](docs/open-core-boundary.md) 与 [客户自托管 runner 上线](docs/customer-hosted-runner-onboarding.md)
- [命名策略](docs/naming-strategy.md)：Nitely 目前是内部代号，在满足文档中的审查门槛前不得公开发布。
- [客户验证](docs/customer-validation.md) 与 [付费试点方案](docs/paid-pilot-offering.md)

## 仓库划分

本仓库是开源、本地优先的运行时；相邻仓库把可选的托管职责分开：

- `nitely-runner`：客户自托管 OCI runner 镜像和 control-plane 协议边界。
- `nitely-control-plane`：可选的协调与策略边界。
- `nitely-cloud`：可选的托管运维边界。

默认情况下，这些仓库不会改变本地源代码、凭据或 evidence 的保管模型。

## 开发

```bash
pnpm run check
pnpm run build
pnpm run test:run
```

完整测试套件以 Linux 为目标，因为 owned-file guard 使用 descriptor-relative 路径锚定；在 macOS 开发时请在 Linux CI 运行完整检查。

## 许可证

Apache-2.0
