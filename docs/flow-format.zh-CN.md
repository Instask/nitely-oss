# Flow 格式

Flow JSON 文档。阶段边界、测试先行拓扑、capabilities 与 runaway ceiling 的编写判断见 [flow authoring guide](flow-authoring-guide.md)。

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

## Bootstrap model 分层

主 `flows/implement-spec-bootstrap.json` 使用显式 model 分层：测试编写使用
`gpt-5.3-codex-spark`，实现使用 `gpt-5.3-codex`，review gate 使用 `gpt-5`。
这样把便宜工作留给低成本模型，把更贵的模型留给决定质量的 review gate。
这只是普通的 runtime/model 配对，不会扩展 schema，也不会自动路由。

其他 provider 的 flow 可以遵循同一约定，但必须使用该 provider 支持的 model id，
并通过仓库的 runtime capability policy 校验；不要假设不同 provider 的名称可互换。
operator 可以复制 flow 后按自己的账号、policy 和成本边界覆盖这些配对。

`required_mcp_servers` 和 `required_connectors` 也可以用在 agent stage 和
review gate 上；同一 stage 内的重复 id 会被 flow validation 拒绝。
