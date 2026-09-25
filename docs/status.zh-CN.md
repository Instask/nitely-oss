# 当前状态

`master` 上已经实现的行为。产品定义见 [product.zh-CN.md](product.zh-CN.md)。安装和文档地图见 [README](../README.zh-CN.md)。

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
  [docs/approval-first-ticket-to-pr.md](approval-first-ticket-to-pr.md)。
- 基于持久化 event log 的 run status、logs 和 resume。
- 用 Nitely 实现 Nitely issue 的 bootstrap flows。
- 主确定性 golden-path demo：从 approved task 经过 verification 和 evidence-backed
  draft PR 发布，再处理 reviewer feedback 并受控更新同一个 PR。见
  [docs/golden-path-demo.md](golden-path-demo.md)。
- GitHub-first 的上游 intake/result contract。见
  [docs/upstream-integration-contract.md](upstream-integration-contract.md)。
- canonical 的 trust-and-verification 产品与架构原则：以证据支撑的软件变更、
  独立验证、基于风险的人类注意力和有界恢复。见
  [docs/trust-and-verification-model.md](trust-and-verification-model.md)。
- Flow-defined work item 与 typed artifact：内置 dev 任务是 `dev.pr`
  work item type，非 dev flow 可以声明自己的 `workItemType`，高风险类型由
  allow-list 管控。见 [docs/work-item-model.md](work-item-model.md)。
- 基于实际 diff 的 risk-based review policy：effective risk class 由声明的
  work item baseline 加上确定性 diff 信号（protected path、migration、
  依赖清单、删除、体量、CODEOWNERS）共同得出，连同抬升它的具体信号一起写入
  run evidence，rework 后重新计算，并由仓库策略映射到所需的人工评审。见
  [docs/risk-based-review-policy.md](risk-based-review-policy.md)。
- 静态 multi-perspective review：correctness、security、spec conformance
  三个固定 review gate 独立运行，由 `review-aggregate` gate 把结论合并成
  一个 fail-closed 的决定，然后才允许 publish。见
  [docs/multi-perspective-review.md](multi-perspective-review.md)。
- Web Console 支持 user-defined flows：列出内置和自定义 flow、从模板创建、
  用 schema-aware validation 编辑 JSON，并直接从 flow 启动 work item。自定义
  flow 存在本地数据库中，运行时不需要 flow 文件。见
  [docs/user-defined-flows.md](user-defined-flows.md)。
- Flow harness 与 audit evidence 已 enforced：artifact integrity/provenance
  (`sha256`、provenance)、command/approval evidence、required-output 与 JSON
  schema validation、stage-level high-risk gating，以及 run evidence timeline。
  见 [docs/harness-and-audit.md](harness-and-audit.md)。
- 面向大输入的 context 交付优化：小型文本 artifact 会完整 inline，大型文本
  artifact 会给出 preview 和必须读取的完整路径，binary artifact 只给出
  metadata/path。Agent 和 review-gate attempt 会记录
  `stage.context.usage`，Web Console 展示 per-stage 和 run-total context usage。
  见 [docs/context-delivery-and-usage.md](context-delivery-and-usage.md)。
- 可 resume 的 agent usage-limit blocker：provider quota/rate-limit 失败会被投影为
  `agent_usage_limit` blocker，而不是普通 attempt failure；resume 后 run 进入
  terminal 状态时，active blocker banner 会清除。
- 结构化操作员提问 blocker：agent stage 可通过经过校验的 `question.json`
  暂停运行，操作员可从 CLI 或 Web Console 回答，resume 会把可审计的决策注入下一次 attempt。
- 高级 Approval Inbox 动作与可选通知投递：通知源声明支持的动作及必填原因，
  人工决策写入 task/run evidence，并以持久化 source-key receipt 对 GitHub、
  Jira、Slack、HTTPS 邮件中继和签名 customer webhook 去重。详见
  [docs/notification-actions-and-delivery.md](notification-actions-and-delivery.md)。
- GitHub Webhook intake：签名校验、repository/actor/installation allowlist、持久化
  delivery queue、GitHub Check Run 与 bounded App callback；Webhook 只创建待审批
  task 或 same-PR rework request，不会绕过人工审批自动启动 run。
- Jira ticket intake 与可选 status sync：支持 Cloud browse URL、allow-listed
  self-hosted base URL、Bearer/PAT 和 Cloud Basic auth；同步失败不会丢弃本地 planning task。
- Required Web Console auth：用户、组织、owner-bound API token、session revoke、
  device-flow browser login 和 metadata-only security audit。密码使用 salted `scrypt`
  hash，API 不返回 secret value。详见
  [docs/enterprise-identity-rbac-and-audit.md](enterprise-identity-rbac-and-audit.md)。
- Web Console 中的 Flow catalog、Flow template、实时 schema validation、Preview
  session 和 provider setup；远程 CLI 还支持 `flow list`、`task create`、`task start`、
  `run list/watch` 与 scheduler HTTP 触发。

正在推进 / 计划中：

- 仅在支持受治理执行时扩展超出本地环境变量和 CLI 检查范围的 provider
  connection；provider 数量不是 roadmap 目标。
