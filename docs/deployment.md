# Deployment

How this repository's production Web checkout is updated. Local development commands are in the [README](../README.md). Commands below are run from a clean local checkout of this repository.

The deployed server should stay on `master`. Nitely-generated branches and
worktrees are execution artifacts for review and should not become the deployed
checkout until their PRs are merged.

Use the production deploy helper from a clean local checkout after the target PR
has merged:

```bash
scripts/nitely-prod-web-deploy
```

The helper deploys `origin/master` on `jerry@100.96.111.79` from
`/home/jerry/nitely`, builds the checkout, and calls
`/home/jerry/bin/nitely-prod-web-restart`. It prepends the production Node bin
directory to `PATH` before installing and building. Before pulling, it reports
dirty tracked and untracked files in the remote production checkout. By default
it preserves that state with a named stash and prints the stash hash plus the
exact commit deployed in the release summary. Use `--dirty-mode abort` when you
want the deploy to stop instead of stashing remote local changes.

Production Web can also be managed by a user-systemd unit while keeping the same
deploy entrypoint:

```bash
scripts/nitely-prod-web-systemd-install
```

The installer writes `~/.config/systemd/user/nitely-web.service` on
`jerry@100.96.111.79`, binds to `127.0.0.1:4173` with required authentication,
and rewrites
`/home/jerry/bin/nitely-prod-web-restart` as a small
`systemctl --user restart nitely-web.service` wrapper. After installation,
`scripts/nitely-prod-web-deploy` still works the same way, but restart is owned
by systemd instead of manual PID replacement. Use `--print-unit` to inspect the
unit without opening an SSH connection, and `--no-start` when you only want to
install the unit and wrapper.
No administrator credential is written to the unit. Bootstrap the first admin
explicitly before starting the production unit. A non-loopback `--host` is
rejected unless `--trusted-proxy` is also present; that option renders the
trusted-proxy declaration and secure-cookie control.
On upgrade, the installer preserves an existing unit only when its supported
effective auth, bind, proxy, and cookie settings classify as secure. It refuses
insecure or unclassifiable units—including units with drop-ins or environment
files—without changing them. After review, `--replace-existing` backs up the
unit and any user drop-ins before installing the secure generated unit. If
systemd reports a different effective fragment or a drop-in outside that user
unit, the installer refuses replacement because it cannot safely neutralize
that external configuration.
