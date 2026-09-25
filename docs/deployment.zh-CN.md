# 部署约定

如何更新本仓库的生产 Web checkout。本地开发命令见 [README](../README.zh-CN.md)。下面的命令从本仓库干净的本地 checkout 运行。

server 上的部署目录应始终保持在 `master`。Nitely 生成的分支和 worktree 是用于审查的运行产物，只有对应 PR 合并后才应进入部署 checkout。

目标 PR 合并后，从干净的本地 checkout 运行生产部署 helper：

```bash
scripts/nitely-prod-web-deploy \
  --remote deploy@nitely-host \
  --prod-dir /srv/nitely \
  --node-bin /opt/node-24/bin \
  --restart-script /srv/bin/nitely-prod-web-restart
```

该 helper 没有任何主机相关的默认值，具体部署的取值应放在该部署自己的
runbook 或 wrapper 中。它会在 `--remote` 上把 `--prod-dir` 更新到
`origin/master`，构建 checkout，并调用 `--restart-script`。安装和构建前，它会把生产 Node bin
目录加入 `PATH`。pull 之前，它会报告远端生产 checkout 中 dirty 的 tracked 和
untracked 文件。默认会用命名 stash 保留这些改动，并在 release summary 中打印
stash hash 和实际部署的 commit。需要在远端有本地改动时直接中止，可使用
`--dirty-mode abort`。

生产 Web 也可以交给 user-systemd unit 管理，同时保持同一个部署入口：

```bash
scripts/nitely-prod-web-systemd-install \
  --remote deploy@nitely-host \
  --prod-dir /srv/nitely \
  --node-bin /opt/node-24/bin \
  --restart-script /srv/bin/nitely-prod-web-restart
```

该 installer 会在 `--remote` 上写入
`~/.config/systemd/user/nitely-web.service`，默认以 required auth 绑定
`127.0.0.1:4173`，
并把 `--restart-script` 改写为
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
