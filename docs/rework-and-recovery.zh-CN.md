# 返工与恢复

已发布的 pull request 如何返工，blocked 或 interrupted 的 run 如何恢复，以及 retry 如何保持有界。命令从仓库根目录运行。

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
详见 [Runaway Ceiling](flow-authoring-guide.md#runaway-ceiling)。

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
