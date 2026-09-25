# 执行后端

一次 run 在哪里执行：宿主机、mise toolchain，或 OCI sandbox。命令使用 `nitely` CLI（安装见 [README](../README.zh-CN.md#安装)），在 Nitely 要操作的仓库中运行。如何启动 run 见 [running-flows.zh-CN.md](running-flows.zh-CN.md)。

Nitely 默认使用 `local` execution backend：每次 run 创建宿主机 git worktree，
command stage 和 agent CLI 都直接在宿主机执行。

如果目标 repo 声明了项目级 toolchain，可以启用轻量 `mise` backend：

```bash
NITELY_EXECUTION_BACKEND=mise nitely web --home . --host 127.0.0.1 --port 4173
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
