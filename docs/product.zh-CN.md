# 产品定义

四条约束定义 Nitely。打破其中一条的提案，是另一个产品。

- **Intent is explicit.** 意图必须明确。
- **Execution is constrained.** 执行必须受约束。
- **Results require evidence.** 结果必须有证据。
- **Humans retain authority.** 人保留决定权。

英文四句是规范表述。下面是它们在系统里的含义。

## 意图必须明确

一次 run 从已批准的产物开始：spec、technical design、ticket snapshot，或其他声明过的 input。产物写明范围，run 记录它消费的是哪一版。对话可以产出这个产物。对话本身不是 run 要执行的意图。

## 执行必须受约束

版本化的 Flow 声明阶段顺序、input、output、工具、gate 和发布行为。Worktree、retry、sandbox 和 agent runtime 都待在这份声明里面。模型碰巧具备的能力，不是这次 run 被授予的权限。

## 结果必须有证据

一个 diff，或一行写着 done 的输出，不是结果。没有参与这次 session 的人，必须能重建是哪些命令、gate、产物、blocker 和决定产生了这次变更。没有这份记录的声称，仍然是未解决的。

## 人保留决定权

批准、审查、draft 发布和 merge 留在人这里。系统按风险把注意力送过去，并记录决定。剩下的问题是这次变更该不该发布时，由人来回答。

## 这些约束产生什么

今天它们表现为一个开源、local-first、受治理的 spec-to-PR 执行系统。经过批准的工程意图变成有证据支撑、可审查的 draft pull request。Codex、Claude、GLM、Grok Build、Pi 以及之后的 coding agent 是 Flow 里面可替换的 runtime。产品是围绕它们的约束和证据。

工作节奏是白天规划，夜间执行，早晨审查。场景见
[usage scenarios and the efficiency thesis](usage-scenarios-and-efficiency-thesis.md)。

## 决策检验

增加一个表面之前，问它服务哪一条：

1. 它是否让已批准的意图及其版本更明确？
2. 它是否写明或收紧了一条执行边界？
3. 它是否让结果在事后可以被核对？
4. 后果性的决定是否仍留在人这里？

一个功能如果只是让 agent 更自主、更像在聊天、或更像一名雇员，它必须通过加强这四条中的一条来获得位置。否则它等待。

## 其他文档的位置

- [信任与验证模型](trust-and-verification-model.md) — 一次变更如何在这些约束里赢得信任。
- [Approval-first ticket-to-PR](approval-first-ticket-to-pr.md) — 已经交付的生命周期。
- [Harness 与审计](harness-and-audit.md) — 第三条所要求的证据。
- [安全与信任](security-and-trust.md) — 代码、secret、日志和执行可以去哪里。
