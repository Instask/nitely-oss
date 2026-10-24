# OCI command mediation

An agent stage can declare which commands it may spawn. This note is the
threat model for enforcing that declaration inside the OCI sandbox, and the
choice of mechanism. It does not change network, filesystem, or secret
isolation.

## What is being protected

The agent process runs as the container's root user, which rootless Docker
maps to an unprivileged host user. It can fork and execute anything in the
image. A prompt that lists allow and deny rules does not stop it from doing
so. The promise, when `capabilities.commands.advisory` is false, is that an
execution outside the stage's command policy does not run.

The runtime command Nitely builds (Claude, Pi, Codex, or another launcher) is
the stage's agent, not one of the commands that policy describes. That first
exec is exempt. Every later `execve` and `execveat` in the process tree is
decided.

## Bypasses a name check has to survive

These are the cases a mechanism has to fail closed on, or the policy has to
be rejected up front:

- The program is named by an absolute path (`/usr/bin/touch`) rather than a
  bare name.
- A shell runs it (`sh -c /usr/bin/touch`). The shell is one exec; the
  command inside it is another, unless it is a shell builtin.
- The caller uses a symlink or an alternate path whose basename is allowed
  and whose target is not (`fake-id` → `/usr/bin/touch`).
- An interpreter performs the exec (`python3 -c` calling `execv`).
- A script's shebang names an interpreter. The kernel runs that interpreter
  inside the script's `execve`, so checking only the script path is not
  enough. Replacing the interpreter path after that check must not select a
  different file.
- A subprocess or another thread performs the exec, including a thread that
  rewrites the pathname after the check has read it.
- The work directory replaces a symlink after the check has resolved it and
  before the kernel walks that path again.
- The syscall uses the x32 ABI. x32 and x86_64 share `AUDIT_ARCH_X86_64`, and
  an x32 number sets `__X32_SYSCALL_BIT`.

A `PATH` wrapper does not survive these. An absolute path never consults
`PATH`. A shell, an interpreter, a symlink, and a direct `execve` do not
either. Nitely does not use one and does not describe one as enforcement.

A static seccomp profile cannot read the pathname. It is a userspace pointer,
and the profile runs without a chance to inspect it.

Seccomp user-notify with `SECCOMP_USER_NOTIF_FLAG_CONTINUE` is not usable for
the allow path. The kernel documents that another thread can rewrite the
pointer arguments while the notifying thread waits, so continuing the
original syscall is not a security check. Denial by skipping the syscall is
safe. Allowing it by `CONTINUE` is not.

## Mechanism

On Linux x86_64 the OCI backend runs `oci-ptrace-seccomp`. The container
command is a small Python supervisor, using the `python3` already in the
runner image. It forks the workload and attaches with `PTRACE_SEIZE`. The
child waits until that attach has stopped it, then installs a seccomp filter.
`PTRACE_INTERRUPT` is only valid for a seized tracee, so the supervisor does
not use `PTRACE_TRACEME`.

The filter returns `SECCOMP_RET_TRACE` for native `execve` (59) and
`execveat` (322). A syscall number with `__X32_SYSCALL_BIT` set is killed,
as is any architecture other than x86_64. Every other x86_64 syscall is
allowed. The parent is not under that filter.

For each exec stop the parent interrupts the other threads in the thread
group and waits until they are stopped. If any interrupt fails, or a thread
is still running when the deadline passes, the exec is denied. The parent
then opens the executable with an `O_NOFOLLOW` walk and holds that inode.
Allow does not resume the original pathname. It points the syscall at the
held inode through the supervisor's `/proc` file descriptor, so replacing a
symlink in the work directory cannot change the file the kernel runs. A
script is handled the same way and then copied. The copy's shebang names the
pinned interpreter inode, and the syscall is pointed at the copy. The kernel
opens that descriptor instead of resolving the shebang path again. If the
interpreter inode cannot be pinned, or the private copy cannot be made, the
script is denied. Deny sets the syscall number to -1 and the return value to
`EPERM`, which skips the syscall instead of continuing it.
`PTRACE_O_EXITKILL` is set, and the child also requests `SIGKILL` if the
parent dies, so a dead supervisor does not leave an unmediated process
running.

The first exec is exempt from the command policy and is pinned the same way,
including when that exec is a script. If its inode or its interpreter cannot
be pinned, the exec is denied.

The decision follows the stage's existing `capabilities.commands` rules.
There is no second policy language. It uses the filename the kernel was
given and the canonical path in the tracee's mount namespace, not `argv[0]`.

- A deny rule matches either the requested path or the resolved path.
- An allow-list matches only the resolved path. `/tmp/fake-id` pointing at
  `/usr/bin/touch` is `touch`, not `fake-id`.
- A shebang is checked as well as the script. The interpreter that runs is
  the inode opened at check time. If the interpreter does not pass, or that
  inode cannot be held, the exec is denied. A shebang whose interpreter is
  itself a script is denied.
- `execveat` with `AT_EMPTY_PATH`, a memfd, an empty filename, or a path that
  does not resolve is denied.
- Argument vectors longer than 64 words, or a pathname that does not fit in
  4096 bytes, are denied.

The same decision function is implemented in TypeScript and in the supervisor.
Tests feed both the same fixtures.

## What this does not enforce

- Shell builtins and other in-process interpreter effects. `sh -c` can run
  builtins without an exec. `python3 -c` can read and write files without an
  exec. Allowing a shell or an interpreter is an explicit policy choice, and
  further execs from that process are still checked.
- Distro symlinks are matched by their target. `/bin/sh` → `dash` is `dash`.
  `/usr/local/bin/python3` → `python3.11` is `python3.11`. An allow rule of
  `sh` or `python3` does not match those targets. Allow the canonical
  basename, or an argv pattern that matches it.
- A renamed copy is whatever its resolved basename is. The mediator does not
  hash file contents.
- Network egress, filesystem mounts, and secret redaction. Those stay on
  their own controls.
- Architectures other than x86_64. `supports` is false there, and
  `advisory: false` fails closed. There is no downgrade to the advisory
  prompt.
- The local and mise backends. They still fail closed when enforcement is
  demanded.
- Tamper-proof denial logs. The supervisor and the agent share a uid, and the
  attempt directory is writable. The log records basenames, rule names, and
  argument counts, and evidence drops any record that carries extra fields.
  A missing supervisor-exit line is reported as incomplete. It is not a
  sealed audit trail.

## Failure

The stage does not start when the supervisor program is missing, the host is
not Linux x86_64, or the image has no `python3` that can load `ctypes` on
x86_64. A mechanism that only claims support, without this supervisor, does
not launch the workload. If the filter or ptrace cannot be installed, the
child exits and the workload is not executed. `advisory: true` stays a stated
policy; OCI does not silently start enforcing it.
