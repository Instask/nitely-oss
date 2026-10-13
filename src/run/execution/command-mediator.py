#!/usr/bin/env python3
"""Supervise agent execve/execveat calls inside an OCI workload.

The mediator is the container's first process. It forks, seizes the child with
PTRACE_SEIZE, and the child installs a seccomp filter that stops native
execve and execveat. x32 syscall numbers are killed. Allow does not resume
the original path: every other thread is stopped first, the executable inode
is pinned with an O_NOFOLLOW walk, and the syscall is pointed at that inode.
A script's interpreter inode is pinned as well. The kernel receives a private
copy of the script whose shebang names that held descriptor, so it cannot
look the interpreter path up again. If a thread cannot be stopped, the inode
cannot be pinned, or that private copy cannot be made, the exec is denied.
Deny sets the syscall number to -1, which skips it and returns EPERM. That
path does not use SECCOMP_USER_NOTIF continue, which the kernel documents as
unsafe for policy.

The first exec is the runtime argv Nitely built and is exempt from the
policy, but it is pinned the same way, including a shebang interpreter. Every
later exec is decided from the execve filename and the pinned inode, never
from argv[0]. If ptrace or seccomp cannot be installed, the child is killed
and this process exits without executing the workload.

x86_64 only. A PATH shim is not used: absolute paths, shells, symlinks, and
interpreters bypass it.
"""

from __future__ import annotations

import ctypes
import errno
import fcntl
import json
import os
import signal
import stat
import sys
import time
from typing import Iterable

MECHANISM_ID = "oci-ptrace-seccomp"
AT_FDCWD = -100
AT_EMPTY_PATH = 0x1000
MAX_ARGC = 64
MAX_PATH = 4096
MAX_SYMLINKS = 40
# Binaries stay on the pinned inode. Scripts are copied so the shebang can
# name that inode; larger files are denied rather than executed unpinned.
SCRIPT_SNAPSHOT_LIMIT = 32 * 1024 * 1024
# linux/memfd.h. Python 3.11 does not export this name. Required when
# vm.memfd_noexec is 1; mode 2 rejects memfd execution entirely.
MFD_EXEC = 0x0010

PTRACE_CONT = 7
PTRACE_SYSCALL = 24
PTRACE_GETREGS = 12
PTRACE_SETREGS = 13
PTRACE_SETOPTIONS = 0x4200
PTRACE_GETEVENTMSG = 0x4201
PTRACE_GETREGSET = 0x4204
PTRACE_SETREGSET = 0x4205
PTRACE_SEIZE = 0x4206
PTRACE_INTERRUPT = 0x4207
NT_PRSTATUS = 1

PTRACE_EVENT_FORK = 1
PTRACE_EVENT_VFORK = 2
PTRACE_EVENT_CLONE = 3
PTRACE_EVENT_EXEC = 4
PTRACE_EVENT_VFORK_DONE = 5
PTRACE_EVENT_SECCOMP = 7
PTRACE_EVENT_STOP = 128

PTRACE_O_TRACEFORK = 1 << PTRACE_EVENT_FORK
PTRACE_O_TRACEVFORK = 1 << PTRACE_EVENT_VFORK
PTRACE_O_TRACECLONE = 1 << PTRACE_EVENT_CLONE
PTRACE_O_TRACEEXEC = 1 << PTRACE_EVENT_EXEC
PTRACE_O_TRACEVFORKDONE = 1 << PTRACE_EVENT_VFORK_DONE
PTRACE_O_TRACESECCOMP = 1 << PTRACE_EVENT_SECCOMP
PTRACE_O_EXITKILL = 1 << 20
TRACE_OPTIONS = (
    PTRACE_O_TRACEFORK
    | PTRACE_O_TRACEVFORK
    | PTRACE_O_TRACECLONE
    | PTRACE_O_TRACEEXEC
    | PTRACE_O_TRACEVFORKDONE
    | PTRACE_O_TRACESECCOMP
    | PTRACE_O_EXITKILL
)

WAIT_WALL = 0x40000000
NR_EXECVE = 59
NR_EXECVEAT = 322
X32_SYSCALL_BIT = 0x40000000
PR_SET_PDEATHSIG = 1
PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2
AUDIT_ARCH_X86_64 = 0xC000003E
SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_TRACE = 0x7FF00000
SECCOMP_RET_ALLOW = 0x7FFF0000
BPF_LD_W_ABS = 0x20
BPF_JMP_JEQ_K = 0x15
BPF_JMP_JSET_K = 0x45
BPF_RET_K = 0x06
SYS_PROCESS_VM_READV = 310
SYS_PROCESS_VM_WRITEV = 311

REG_R10 = 7
REG_R8 = 8
REG_RAX = 10
REG_RDX = 12
REG_RSI = 13
REG_RDI = 14
REG_ORIG_RAX = 15
REG_RSP = 19


class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_uint16),
        ("jt", ctypes.c_uint8),
        ("jf", ctypes.c_uint8),
        ("k", ctypes.c_uint32),
    ]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


class IOVec(ctypes.Structure):
    _fields_ = [("iov_base", ctypes.c_void_p), ("iov_len", ctypes.c_size_t)]


LIBC = ctypes.CDLL("libc.so.6", use_errno=True)
LIBC.ptrace.argtypes = [
    ctypes.c_uint64,
    ctypes.c_uint64,
    ctypes.c_uint64,
    ctypes.c_void_p,
]
LIBC.ptrace.restype = ctypes.c_long
LIBC.prctl.argtypes = [
    ctypes.c_int,
    ctypes.c_ulong,
    ctypes.c_ulong,
    ctypes.c_ulong,
    ctypes.c_ulong,
]
LIBC.prctl.restype = ctypes.c_int
LIBC.syscall.argtypes = [
    ctypes.c_long,
    ctypes.c_long,
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.c_ulong,
]
LIBC.syscall.restype = ctypes.c_long


def ptrace(request: int, pid: int, addr: int = 0, data: int = 0) -> int:
    result = LIBC.ptrace(request, pid, addr, ctypes.c_void_p(data))
    if result == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), request)
    return int(result)


def glob_to_regexp(pattern: str) -> str:
    pieces: list[str] = []
    for character in pattern:
        if character == "*":
            pieces.append(".*")
        elif character == "?":
            pieces.append(".")
        else:
            pieces.append(__import__("re").escape(character))
    return "".join(pieces)


def normalize_entries(entries: Iterable[object]) -> list[str]:
    cleaned = {
        entry.strip()
        for entry in entries
        if isinstance(entry, str) and entry.strip() != ""
    }
    return sorted(cleaned)


def normalize_policy(raw: dict[str, object]) -> dict[str, object]:
    mode = raw.get("mode")
    if mode not in ("none", "allow-list", "deny-list", "unrestricted"):
        raise ValueError("command policy mode is invalid")
    allow = normalize_entries(raw.get("allow") or [])  # type: ignore[arg-type]
    deny = normalize_entries(raw.get("deny") or [])  # type: ignore[arg-type]
    advisory = bool(raw.get("advisory"))
    policy_id = raw.get("policyId")
    if not isinstance(policy_id, str) or policy_id == "":
        allow_text = ",".join(allow) if allow else "none"
        deny_text = ",".join(deny) if deny else "none"
        policy_id = (
            f"commands/v1:{mode}:{'advisory' if advisory else 'enforced'}"
            f":allow({allow_text}):deny({deny_text})"
        )
    return {
        "mode": mode,
        "allow": allow,
        "deny": deny,
        "advisory": advisory,
        "policyId": policy_id,
    }


def command_lines(argv: list[str]) -> list[str]:
    if not argv:
        return []
    program = argv[0]
    lines = [" ".join(argv)]
    base = program.rsplit("/", 1)[-1]
    if base != program:
        lines.append(" ".join([base, *argv[1:]]))
    return lines


def command_rule_matches(rule: str, argv: list[str]) -> bool:
    import re

    if not argv:
        return False
    trimmed = rule.strip()
    if trimmed == "":
        return False
    program = argv[0]
    if not any(character in trimmed for character in " \t*?"):
        if "/" in trimmed:
            return program == trimmed
        return program == trimmed or program.rsplit("/", 1)[-1] == trimmed
    expression = re.compile(f"^{glob_to_regexp(trimmed)}$")
    return any(expression.fullmatch(line) for line in command_lines(argv))


def decide_command(policy: dict[str, object], argv: list[str]) -> dict[str, str]:
    mode = policy["mode"]
    if mode == "unrestricted":
        return {"decision": "allow", "reason": "command mode unrestricted"}
    if not argv or argv[0].strip() == "":
        return {"decision": "deny", "reason": "command has no program"}
    deny = policy["deny"]
    assert isinstance(deny, list)
    for rule in deny:
        if command_rule_matches(str(rule), argv):
            return {
                "decision": "deny",
                "rule": str(rule),
                "reason": f"denied by deny rule {rule}",
            }
    if mode == "none":
        return {"decision": "deny", "reason": "command mode none forbids every command"}
    if mode == "deny-list":
        return {"decision": "allow", "reason": "no deny rule matched"}
    allow = policy["allow"]
    assert isinstance(allow, list)
    for rule in allow:
        if command_rule_matches(str(rule), argv):
            return {
                "decision": "allow",
                "rule": str(rule),
                "reason": f"allowed by allow rule {rule}",
            }
    return {"decision": "deny", "reason": "no allow rule matched"}


def decide_mediated_exec(
    policy: dict[str, object],
    requested_path: str,
    canonical_path: str | None,
    args: list[str],
    interpreter_path: str | None = None,
) -> dict[str, str]:
    """Match the TypeScript decideMediatedExec contract, including reasons."""
    if policy["mode"] == "unrestricted":
        return {"decision": "allow", "reason": "command mode unrestricted"}
    if (
        not isinstance(canonical_path, str)
        or not canonical_path.startswith("/")
        or canonical_path.strip() == ""
    ):
        return {"decision": "deny", "reason": "executable path could not be resolved"}
    if interpreter_path == "":
        return {"decision": "deny", "reason": "shebang interpreter denied"}

    requested = [requested_path, *args] if requested_path != "" else [canonical_path, *args]
    canonical = [canonical_path, *args]
    views = [canonical]
    if requested[0] != canonical[0]:
        views.append(requested)
    deny = policy["deny"]
    assert isinstance(deny, list)
    for argv in views:
        for rule in deny:
            if command_rule_matches(str(rule), argv):
                return {
                    "decision": "deny",
                    "rule": str(rule),
                    "reason": f"denied by deny rule {rule}",
                }
    if policy["mode"] == "none":
        return {"decision": "deny", "reason": "command mode none forbids every command"}

    def interpreter_denial() -> dict[str, str] | None:
        if interpreter_path is None:
            return None
        nested = decide_mediated_exec(policy, interpreter_path, interpreter_path, [])
        if nested["decision"] == "allow":
            return None
        if "rule" in nested:
            return {
                "decision": "deny",
                "rule": nested["rule"],
                "reason": f"shebang interpreter denied by rule {nested['rule']}",
            }
        return {"decision": "deny", "reason": "shebang interpreter denied"}

    if policy["mode"] == "deny-list":
        denied = interpreter_denial()
        return denied or {"decision": "allow", "reason": "no deny rule matched"}

    allow = policy["allow"]
    assert isinstance(allow, list)
    matched: str | None = None
    for rule in allow:
        if command_rule_matches(str(rule), canonical):
            matched = str(rule)
            break
    if matched is None:
        return {
            "decision": "deny",
            "reason": "no allow rule matched the resolved executable",
        }
    denied = interpreter_denial()
    if denied:
        return denied
    return {
        "decision": "allow",
        "rule": matched,
        "reason": f"allowed by allow rule {matched}",
    }


def program_basename(path: str | None) -> str:
    if not path:
        return "unresolved"
    name = path.rsplit("/", 1)[-1]
    if not name or any(character in name for character in " \t\n=/"):
        return "unresolved"
    return name[:128]


class Evidence:
    def __init__(self, path: str) -> None:
        self.decisions = 0
        self.denials = 0
        flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY
        self.fd = os.open(path, flags, 0o644)
        fcntl.fcntl(self.fd, fcntl.F_SETFD, fcntl.FD_CLOEXEC)

    def write(self, record: dict[str, object]) -> None:
        line = json.dumps(record, separators=(",", ":"), sort_keys=True)
        os.write(self.fd, (line + "\n").encode())

    def decision(self, record: dict[str, object]) -> None:
        self.decisions += 1
        if record.get("decision") == "deny":
            self.denials += 1
        self.write(record)

    def close(self, error: str | None = None) -> None:
        if error:
            self.write({"event": "error", "reason": error})
        self.write(
            {
                "event": "supervisor-exit",
                "decisions": self.decisions,
                "denials": self.denials,
            }
        )
        os.close(self.fd)


def vm_read(pid: int, address: int, size: int) -> bytes:
    if address <= 0 or size <= 0:
        raise OSError(errno.EFAULT, "empty remote read")
    buffer = ctypes.create_string_buffer(size)
    local = IOVec(ctypes.cast(buffer, ctypes.c_void_p), size)
    remote = IOVec(ctypes.c_void_p(address), size)
    read = LIBC.syscall(
        SYS_PROCESS_VM_READV,
        pid,
        ctypes.byref(local),
        1,
        ctypes.byref(remote),
        1,
        0,
    )
    if read < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return buffer.raw[:read]


def read_c_string(pid: int, address: int) -> str | None:
    if address <= 0:
        return None
    chunks: list[bytes] = []
    remaining = MAX_PATH
    cursor = address
    while remaining > 0:
        try:
            block = vm_read(pid, cursor, min(256, remaining))
        except OSError:
            return None
        if not block:
            return None
        end = block.find(b"\x00")
        if end >= 0:
            chunks.append(block[:end])
            break
        chunks.append(block)
        cursor += len(block)
        remaining -= len(block)
    else:
        return None
    try:
        return b"".join(chunks).decode("utf-8", "surrogateescape")
    except UnicodeError:
        return None


def read_word(pid: int, address: int) -> int | None:
    try:
        raw = vm_read(pid, address, 8)
    except OSError:
        return None
    if len(raw) != 8:
        return None
    return int.from_bytes(raw, "little")


def read_argv(pid: int, address: int) -> list[str] | None:
    if address <= 0:
        return None
    args: list[str] = []
    for index in range(MAX_ARGC + 1):
        word = read_word(pid, address + index * 8)
        if word is None:
            return None
        if word == 0:
            return args
        if index == MAX_ARGC:
            return None
        value = read_c_string(pid, word)
        if value is None:
            return None
        args.append(value)
    return None


def get_registers(pid: int) -> ctypes.Array[ctypes.c_ulonglong]:
    regs = (ctypes.c_ulonglong * 27)()
    address = ctypes.addressof(regs)
    try:
        ptrace(PTRACE_GETREGS, pid, 0, address)
        return regs
    except OSError:
        vector = IOVec(ctypes.c_void_p(address), ctypes.sizeof(regs))
        ptrace(PTRACE_GETREGSET, pid, NT_PRSTATUS, ctypes.addressof(vector))
        return regs


def set_registers(pid: int, regs: ctypes.Array[ctypes.c_ulonglong]) -> None:
    address = ctypes.addressof(regs)
    try:
        ptrace(PTRACE_SETREGS, pid, 0, address)
    except OSError:
        vector = IOVec(ctypes.c_void_p(address), ctypes.sizeof(regs))
        ptrace(PTRACE_SETREGSET, pid, NT_PRSTATUS, ctypes.addressof(vector))


def skip_syscall(pid: int) -> None:
    regs = get_registers(pid)
    regs[REG_ORIG_RAX] = ctypes.c_ulonglong(-1).value
    regs[REG_RAX] = ctypes.c_ulonglong(-errno.EPERM).value
    set_registers(pid, regs)


def tgid_of(pid: int) -> int:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("Tgid:"):
                    return int(line.split()[1])
    except (OSError, IndexError, ValueError):
        return pid
    return pid


def thread_ids(tgid: int) -> list[int]:
    try:
        return [int(tid) for tid in os.listdir(f"/proc/{tgid}/task")]
    except (OSError, ValueError):
        return [tgid]


def _close_quiet(fd: int) -> None:
    try:
        os.close(fd)
    except OSError:
        pass


def _split_components(text: str) -> list[str]:
    return [part for part in text.split("/") if part not in ("", ".")]


def pin_inode(pid: int, filename: str, dirfd: int | None) -> tuple[int, str] | None:
    """Open the final regular file with O_NOFOLLOW and return that fd.

    Symlink components are read once and the walk continues from that text.
    The fd keeps the inode that was opened, so a later replacement of a
    directory entry cannot change which file is executed.
    """
    if filename == "" or "\x00" in filename:
        return None
    opened: list[int] = []

    def take(fd: int) -> int:
        opened.append(fd)
        return fd

    try:
        root = take(os.open(
            f"/proc/{pid}/root",
            os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC,
        ))
        if filename.startswith("/"):
            directory = root
            canonical: list[str] = []
            parts = _split_components(filename)
        else:
            if dirfd is not None and dirfd != AT_FDCWD:
                base_link = os.readlink(f"/proc/{pid}/fd/{dirfd}")
                directory = take(os.open(
                    f"/proc/{pid}/fd/{dirfd}",
                    os.O_PATH | os.O_CLOEXEC,
                ))
            else:
                base_link = os.readlink(f"/proc/{pid}/cwd")
                directory = take(os.open(
                    f"/proc/{pid}/cwd",
                    os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC,
                ))
            if base_link.endswith(" (deleted)") or not base_link.startswith("/"):
                return None
            canonical = _split_components(base_link)
            parts = _split_components(filename)
        hops = 0
        index = 0
        while index < len(parts):
            segment = parts[index]
            index += 1
            if segment == "..":
                if canonical:
                    canonical.pop()
                parent = take(os.open(
                    "..",
                    os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=directory,
                ))
                if directory != root:
                    opened.remove(directory)
                    _close_quiet(directory)
                directory = parent
                continue
            last = index >= len(parts)
            flags = (
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
                if last
                else os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            )
            try:
                nxt = take(os.open(segment, flags, dir_fd=directory))
            except OSError as error:
                # O_DIRECTORY|O_NOFOLLOW reports a symlink as ENOTDIR. A final
                # symlink is ELOOP. Either way the walk continues from the
                # link text rather than from a later lookup.
                if error.errno not in (errno.ELOOP, errno.ENOTDIR):
                    return None
                try:
                    link = os.readlink(segment, dir_fd=directory)
                except OSError:
                    return None
                hops += 1
                if hops > MAX_SYMLINKS:
                    return None
                extra = _split_components(link)
                if link.startswith("/"):
                    parts = extra + parts[index:]
                    index = 0
                    if directory != root:
                        opened.remove(directory)
                        _close_quiet(directory)
                    directory = root
                    canonical = []
                else:
                    parts = extra + parts[index:]
                    index = 0
                continue
            info = os.fstat(nxt)
            if last:
                if not stat.S_ISREG(info.st_mode):
                    return None
                canonical.append(segment)
                opened.remove(nxt)
                if directory != root:
                    opened.remove(directory)
                    _close_quiet(directory)
                return nxt, "/" + "/".join(canonical)
            if not stat.S_ISDIR(info.st_mode):
                return None
            canonical.append(segment)
            if directory != root:
                opened.remove(directory)
                _close_quiet(directory)
            directory = nxt
        return None
    except OSError:
        return None
    finally:
        for fd in opened:
            _close_quiet(fd)


def read_shebang(fd: int) -> tuple[str, str] | None:
    """Return the interpreter token and its optional argument.

    None means the file is not a shebang. An empty interpreter means the
    shebang cannot be trusted, including a line that does not fit in the
    kernel's 256-byte buffer.
    """
    try:
        header = os.pread(fd, 256, 0)
    except OSError:
        return None
    if not header.startswith(b"#!"):
        return None
    newline = header.find(b"\n")
    if newline < 0 and len(header) >= 256:
        return ("", "")
    line = header[2:] if newline < 0 else header[2:newline]
    text = line.decode("utf-8", "surrogateescape").lstrip(" \t")
    if text.strip(" \t") == "":
        return ("", "")
    parts = text.split(None, 1)
    if not parts or parts[0] == "":
        return ("", "")
    optional = parts[1].strip(" \t") if len(parts) > 1 else ""
    if "\x00" in parts[0] or "\x00" in optional:
        return ("", "")
    return parts[0], optional


def shebang_interpreter_fd(fd: int) -> str | None:
    parsed = read_shebang(fd)
    if parsed is None:
        return None
    return parsed[0]


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        wrote = os.write(fd, view)
        if wrote <= 0:
            raise OSError(errno.EIO, "short write")
        view = view[wrote:]


def _memfd_noexec() -> int:
    try:
        with open("/proc/sys/vm/memfd_noexec", encoding="ascii") as handle:
            return int(handle.read().strip() or "0")
    except (OSError, ValueError):
        return 0


def _create_writable_private() -> int | None:
    noexec = _memfd_noexec()
    if noexec < 2:
        flags = os.MFD_CLOEXEC | (MFD_EXEC if noexec == 1 else 0)
        try:
            return os.memfd_create("nitely-script", flags)
        except (AttributeError, OSError):
            pass
    for directory in ("/dev/shm", "/tmp"):
        try:
            return os.open(directory, os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC, 0o700)
        except OSError:
            continue
    return None


def script_bound_to_interpreter(
    script_fd: int,
    interpreter_fd: int,
    interpreter: str,
) -> int | None:
    """Copy the script so its shebang opens the held interpreter inode.

    The kernel reads the shebang after exec resumes and looks that path up
    itself. The copy names /proc/<supervisor>/fd/<interpreter>, which stays
    attached to the inode checked above. The original script fd is left open
    for the caller.
    """
    if interpreter == "" or "\x00" in interpreter:
        return None
    try:
        size = os.fstat(script_fd).st_size
    except OSError:
        return None
    if size < 2 or size > SCRIPT_SNAPSHOT_LIMIT:
        return None
    parsed = read_shebang(script_fd)
    if parsed is None or parsed[0] != interpreter:
        return None
    _token, optional = parsed
    proc_path = f"/proc/{os.getpid()}/fd/{interpreter_fd}"
    if any(character in proc_path for character in " \t\n\x00"):
        return None
    rewritten = (
        f"#!{proc_path} {optional}\n" if optional else f"#!{proc_path}\n"
    ).encode("utf-8", "surrogateescape")
    # The newline has to sit inside the kernel's 256-byte shebang buffer.
    if len(rewritten) > 256:
        return None
    try:
        header = os.pread(script_fd, min(256, size), 0)
    except OSError:
        return None
    newline = header.find(b"\n")
    if newline < 0:
        if len(header) != size:
            return None
        body_offset = size
    else:
        body_offset = newline + 1
    writable = _create_writable_private()
    if writable is None:
        return None
    try:
        _write_all(writable, rewritten)
        remaining = size - body_offset
        offset = body_offset
        while remaining > 0:
            chunk = os.pread(script_fd, min(1 << 20, remaining), offset)
            if not chunk:
                raise OSError(errno.EIO, "short script")
            _write_all(writable, chunk)
            offset += len(chunk)
            remaining -= len(chunk)
        if os.fstat(script_fd).st_size != size:
            raise OSError(errno.EIO, "script changed")
        # A file still open for writing returns ETXTBSY from exec. Reopen
        # read-only, then drop the writable descriptor. The inode remains.
        return os.open(f"/proc/self/fd/{writable}", os.O_RDONLY | os.O_CLOEXEC)
    except OSError:
        return None
    finally:
        _close_quiet(writable)


def vm_write(pid: int, address: int, data: bytes) -> None:
    if address <= 0 or not data:
        raise OSError(errno.EFAULT, "empty remote write")
    buffer = ctypes.create_string_buffer(data)
    local = IOVec(ctypes.cast(buffer, ctypes.c_void_p), len(data))
    remote = IOVec(ctypes.c_void_p(address), len(data))
    written = LIBC.syscall(
        SYS_PROCESS_VM_WRITEV,
        pid,
        ctypes.byref(local),
        1,
        ctypes.byref(remote),
        1,
        0,
    )
    if written != len(data):
        error = ctypes.get_errno()
        raise OSError(error or errno.EIO, os.strerror(error) if error else "short write")


def redirect_exec(
    pid: int,
    regs: ctypes.Array[ctypes.c_ulonglong],
    path: str,
) -> None:
    encoded = path.encode("utf-8") + b"\x00"
    if len(encoded) > 240:
        raise OSError(errno.ENAMETOOLONG, "pinned path")
    address = int(regs[REG_RSP]) - 256
    if address <= 0:
        raise OSError(errno.EFAULT, "stack")
    vm_write(pid, address, encoded)
    number = int(regs[REG_ORIG_RAX])
    if number == NR_EXECVE:
        regs[REG_RDI] = address
    elif number == NR_EXECVEAT:
        regs[REG_RSI] = address
        regs[REG_R8] = int(regs[REG_R8]) & ~AT_EMPTY_PATH
    else:
        raise OSError(errno.EINVAL, "syscall")
    set_registers(pid, regs)


def exec_seccomp_program() -> list[tuple[int, int, int, int]]:
    # Kill other ABIs and every x32 syscall. Trace native execve/execveat.
    return [
        (BPF_LD_W_ABS, 0, 0, 4),
        (BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64),
        (BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        (BPF_LD_W_ABS, 0, 0, 0),
        (BPF_JMP_JSET_K, 0, 1, X32_SYSCALL_BIT),
        (BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        (BPF_JMP_JEQ_K, 2, 0, NR_EXECVE),
        (BPF_JMP_JEQ_K, 1, 0, NR_EXECVEAT),
        (BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
        (BPF_RET_K, 0, 0, SECCOMP_RET_TRACE),
    ]


def execute_seccomp_program(arch: int, number: int) -> int:
    packet = bytearray(64)
    packet[0:4] = (number & 0xFFFFFFFF).to_bytes(4, "little")
    packet[4:8] = (arch & 0xFFFFFFFF).to_bytes(4, "little")
    program = exec_seccomp_program()
    accumulator = 0
    pc = 0
    for _step in range(64):
        if pc < 0 or pc >= len(program):
            return SECCOMP_RET_KILL_PROCESS
        code, jt, jf, constant = program[pc]
        if code == BPF_LD_W_ABS:
            accumulator = int.from_bytes(packet[constant:constant + 4], "little")
            pc += 1
            continue
        if code == BPF_JMP_JEQ_K:
            pc += 1 + (jt if accumulator == constant else jf)
            continue
        if code == BPF_JMP_JSET_K:
            pc += 1 + (jt if (accumulator & constant) != 0 else jf)
            continue
        if code == BPF_RET_K:
            return constant
        return SECCOMP_RET_KILL_PROCESS
    return SECCOMP_RET_KILL_PROCESS


def install_seccomp_filter() -> None:
    program = exec_seccomp_program()
    filters = (SockFilter * len(program))(*(
        SockFilter(code, jt, jf, constant) for code, jt, jf, constant in program
    ))
    sock = SockFprog(len(program), filters)
    if LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "no_new_privs")
    LIBC.prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    if LIBC.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(sock), 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "seccomp")


def child_main(parent: int, ready_fd: int, argv: list[str]) -> None:
    if LIBC.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        os._exit(127)
    if os.getppid() != parent:
        os._exit(127)
    try:
        os.read(ready_fd, 1)
    except OSError:
        os._exit(127)
    os.close(ready_fd)
    try:
        install_seccomp_filter()
    except OSError:
        os._exit(127)
    try:
        os.execvpe(argv[0], argv, os.environ)
    except OSError:
        os._exit(127)


def event_of(status: int) -> int:
    return (status >> 16) & 0xFFFF


def cont(pid: int, sig: int = 0) -> None:
    try:
        ptrace(PTRACE_CONT, pid, 0, sig)
    except OSError as error:
        if error.errno not in (errno.ESRCH, errno.EIO):
            raise


def set_options(pid: int) -> None:
    ptrace(PTRACE_SETOPTIONS, pid, 0, TRACE_OPTIONS)


def event_message(pid: int) -> int:
    message = ctypes.c_ulonglong(0)
    ptrace(PTRACE_GETEVENTMSG, pid, 0, ctypes.addressof(message))
    return int(message.value)


class Supervisor:
    def __init__(self, root: int, policy: dict[str, object], evidence: Evidence) -> None:
        self.root = root
        self.policy = policy
        self.evidence = evidence
        self.fresh: set[int] = {root}
        self.launch_pending = True
        self.root_status: int | None = None
        self.queue: list[tuple[int, int]] = []
        self.live: set[int] = {root}
        self.binary_pins: dict[int, int] = {}
        self.script_pins: dict[int, list[int]] = {}
        self.syscall_resume: int | None = None

    def wait_next(self, hang: bool) -> tuple[int, int] | None:
        if self.queue:
            return self.queue.pop(0)
        flag = WAIT_WALL if hang else WAIT_WALL | os.WNOHANG
        try:
            pid, status = os.waitpid(-1, flag)
        except ChildProcessError:
            return None
        if pid == 0:
            return None
        return pid, status

    def note_exit(self, pid: int, status: int) -> None:
        self._release_pins(pid)
        self.live.discard(pid)
        self.fresh.discard(pid)
        if pid == self.root or tgid_of(pid) == self.root and pid == self.root:
            self.root_status = status
        if tgid_of(pid) == pid and pid == self.root:
            self.root_status = status

    def _release_binary_pin(self, pid: int) -> None:
        fd = self.binary_pins.pop(pid, None)
        if fd is not None:
            _close_quiet(fd)

    def _release_pins(self, pid: int) -> None:
        self._release_binary_pin(pid)
        for fd in self.script_pins.pop(pid, []):
            _close_quiet(fd)

    def freeze(self, origin: int) -> bool:
        tgid = tgid_of(origin)
        stopped = {origin, *(pid for pid, _status in self.queue)}
        requested: set[int] = set()
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            pending: set[int] = set()
            for tid in thread_ids(tgid):
                if tid in stopped:
                    continue
                if tid not in requested:
                    try:
                        ptrace(PTRACE_INTERRUPT, tid)
                    except OSError as error:
                        if error.errno == errno.ESRCH:
                            stopped.add(tid)
                            continue
                        return False
                    requested.add(tid)
                pending.add(tid)
            if not pending:
                return True
            while pending and time.monotonic() < deadline:
                item = self.wait_next(False)
                if item is None:
                    time.sleep(0.005)
                    break
                pid, status = item
                if pid == origin:
                    continue
                if not os.WIFSTOPPED(status):
                    self.note_exit(pid, status)
                    pending.discard(pid)
                    stopped.add(pid)
                    continue
                pending.discard(pid)
                stopped.add(pid)
                if event_of(status) != PTRACE_EVENT_STOP:
                    self.queue.append((pid, status))
        return False

    def resume_group(self, origin: int) -> None:
        queued = {pid for pid, _status in self.queue}
        syscall_origin = self.syscall_resume == origin
        self.syscall_resume = None
        for tid in thread_ids(tgid_of(origin)):
            if tid in queued and tid != origin:
                continue
            if tid == origin and syscall_origin:
                try:
                    ptrace(PTRACE_SYSCALL, tid)
                except OSError as error:
                    if error.errno not in (errno.ESRCH, errno.EIO):
                        raise
                continue
            cont(tid, 0)

    def _deny(self, pid: int, reason: str) -> None:
        self.evidence.decision(
            {
                "argc": 0,
                "decision": "deny",
                "event": "decision",
                "program": "unresolved",
                "reason": reason,
            }
        )
        try:
            skip_syscall(pid)
        except OSError:
            os.kill(pid, signal.SIGKILL)
        self.resume_group(pid)

    def decide_stop(self, pid: int) -> None:
        if not self.freeze(pid):
            self._deny(pid, "trace group could not be stopped")
            return
        try:
            regs = get_registers(pid)
            decision, pin = self.decide_registers(pid, regs)
        except OSError:
            self._deny(pid, "executable path could not be resolved")
            return
        if decision["decision"] == "deny" or pin is None:
            if pin is not None:
                _close_quiet(pin[0])
                for held in pin[2]:
                    _close_quiet(held)
            if decision["decision"] != "deny":
                decision = {
                    "argc": decision.get("argc", 0),
                    "decision": "deny",
                    "event": "decision",
                    "program": "unresolved",
                    "reason": "executable path could not be resolved",
                }
            try:
                skip_syscall(pid)
            except OSError:
                os.kill(pid, signal.SIGKILL)
            self.evidence.decision(decision)
            self.resume_group(pid)
            return
        fd, hold, extra = pin
        try:
            redirect_exec(pid, regs, f"/proc/{os.getpid()}/fd/{fd}")
        except OSError:
            _close_quiet(fd)
            for held in extra:
                _close_quiet(held)
            self._deny(pid, "executable path could not be resolved")
            return
        if hold:
            held_fds = self.script_pins.setdefault(pid, [])
            held_fds.append(fd)
            held_fds.extend(extra)
        else:
            for held in extra:
                _close_quiet(held)
            previous = self.binary_pins.get(pid)
            if previous is not None and previous != fd:
                _close_quiet(previous)
            self.binary_pins[pid] = fd
        self.syscall_resume = pid
        self.evidence.decision(decision)
        self.resume_group(pid)

    def decide_registers(
        self,
        pid: int,
        regs: ctypes.Array[ctypes.c_ulonglong],
    ) -> tuple[dict[str, object], tuple[int, bool, list[int]] | None]:
        number = int(regs[REG_ORIG_RAX])
        if number == NR_EXECVE:
            filename = read_c_string(pid, int(regs[REG_RDI])) or ""
            argv = read_argv(pid, int(regs[REG_RSI]))
            dirfd = None
            flags = 0
        elif number == NR_EXECVEAT:
            dirfd = ctypes.c_long(int(regs[REG_RDI])).value
            filename = read_c_string(pid, int(regs[REG_RSI])) or ""
            argv = read_argv(pid, int(regs[REG_RDX]))
            flags = int(regs[REG_R8])
        else:
            filename = ""
            argv = None
            dirfd = None
            flags = 0
        argc = 0 if argv is None else len(argv)
        unresolved = {
            "argc": argc,
            "decision": "deny",
            "event": "decision",
            "program": "unresolved",
            "reason": "executable path could not be resolved",
        }
        if argv is None or (flags & AT_EMPTY_PATH and filename == "") or number not in (
            NR_EXECVE,
            NR_EXECVEAT,
        ):
            return unresolved, None
        pinned = pin_inode(pid, filename, dirfd)
        if pinned is None:
            return unresolved, None
        fd, canonical = pinned
        shebang = shebang_interpreter_fd(fd)
        interpreter: str | None = None
        interp_fd: int | None = None
        if shebang is not None:
            if shebang == "":
                interpreter = ""
            else:
                resolved = pin_inode(pid, shebang, None)
                if resolved is None:
                    interpreter = ""
                else:
                    interp_fd, interp_path = resolved
                    nested = shebang_interpreter_fd(interp_fd)
                    if nested is not None:
                        _close_quiet(interp_fd)
                        interp_fd = None
                        interpreter = ""
                    else:
                        interpreter = interp_path

        def close_checked() -> None:
            _close_quiet(fd)
            if interp_fd is not None:
                _close_quiet(interp_fd)

        def denied_script(program: str) -> tuple[dict[str, object], None]:
            close_checked()
            return {
                "argc": argc,
                "decision": "deny",
                "event": "decision",
                "program": program,
                "reason": "shebang interpreter denied",
            }, None

        def executable(
            record: dict[str, object],
        ) -> tuple[dict[str, object], tuple[int, bool, list[int]] | None]:
            if shebang is None:
                return record, (fd, False, [])
            # Keep the interpreter fd open. The private copy's shebang names
            # it, and the kernel opens that path only after this syscall resumes.
            if interp_fd is None or not interpreter:
                return denied_script(str(record.get("program") or "unresolved"))
            bound = script_bound_to_interpreter(fd, interp_fd, shebang)
            _close_quiet(fd)
            if bound is None:
                _close_quiet(interp_fd)
                return {
                    "argc": argc,
                    "decision": "deny",
                    "event": "decision",
                    "program": str(record.get("program") or "unresolved"),
                    "reason": "shebang interpreter denied",
                }, None
            return record, (bound, True, [interp_fd])

        program = program_basename(canonical or filename)
        if self.launch_pending and pid == self.root:
            self.launch_pending = False
            if interpreter == "":
                return denied_script(program)
            return executable({
                "argc": argc,
                "decision": "allow",
                "event": "launch",
                "program": program,
                "reason": "launch exempt",
            })
        args = argv[1:] if argv else []
        decided = decide_mediated_exec(
            self.policy,
            filename,
            canonical,
            args,
            interpreter,
        )
        record: dict[str, object] = {
            "argc": argc,
            "decision": decided["decision"],
            "event": "decision",
            "program": program,
            "reason": decided["reason"],
        }
        if "rule" in decided:
            record["rule"] = decided["rule"]
        if decided["decision"] != "allow":
            close_checked()
            return record, None
        return executable(record)

    def handle(self, pid: int, status: int) -> None:
        if os.WIFSTOPPED(status):
            self._release_binary_pin(pid)
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            self.note_exit(pid, status)
            if pid == self.root:
                self.root_status = status
            return
        if not os.WIFSTOPPED(status):
            return
        self.live.add(pid)
        event = event_of(status)
        sig = os.WSTOPSIG(status)
        if event in (PTRACE_EVENT_FORK, PTRACE_EVENT_VFORK, PTRACE_EVENT_CLONE):
            try:
                child = event_message(pid)
                set_options(child)
                self.fresh.add(child)
                self.live.add(child)
            except OSError:
                pass
            cont(pid, 0)
            return
        if event == PTRACE_EVENT_SECCOMP:
            self.decide_stop(pid)
            return
        if event in (PTRACE_EVENT_EXEC, PTRACE_EVENT_VFORK_DONE, PTRACE_EVENT_STOP):
            cont(pid, 0)
            return
        if event == 0 and sig == signal.SIGSTOP and pid in self.fresh:
            self.fresh.discard(pid)
            try:
                set_options(pid)
            except OSError:
                pass
            cont(pid, 0)
            return
        if event == 0 and sig == signal.SIGTRAP:
            cont(pid, 0)
            return
        cont(pid, sig if event == 0 else 0)

    def run(self) -> int:
        while self.live:
            item = self.wait_next(True)
            if item is None:
                break
            self.handle(*item)
        if self.root_status is None:
            return 127
        if os.WIFEXITED(self.root_status):
            return os.WEXITSTATUS(self.root_status)
        if os.WIFSIGNALED(self.root_status):
            return 128 + os.WTERMSIG(self.root_status)
        return 127


def decide_only() -> int:
    raw = json.load(sys.stdin)
    if not isinstance(raw, dict):
        raise ValueError("decide-only input must be an object")
    policy = normalize_policy(raw["policy"])
    args = raw.get("args") or []
    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise ValueError("args must be strings")
    interpreter = raw.get("interpreterPath")
    if interpreter is not None and not isinstance(interpreter, str):
        raise ValueError("interpreterPath must be a string")
    canonical = raw.get("canonicalPath")
    if canonical is not None and not isinstance(canonical, str):
        raise ValueError("canonicalPath must be a string")
    requested = raw.get("requestedPath")
    if not isinstance(requested, str):
        raise ValueError("requestedPath must be a string")
    json.dump(
        decide_mediated_exec(policy, requested, canonical, args, interpreter),
        sys.stdout,
        separators=(",", ":"),
        sort_keys=True,
    )
    sys.stdout.write("\n")
    return 0


def supervise(policy: dict[str, object], evidence_path: str, argv: list[str]) -> int:
    if sys.platform != "linux" or os.uname().machine != "x86_64":
        evidence = Evidence(evidence_path)
        evidence.close("mediator requires Linux x86_64")
        return 127
    evidence = Evidence(evidence_path)
    evidence.write(
        {
            "advisory": bool(policy["advisory"]),
            "event": "effective",
            "mechanism": MECHANISM_ID,
            "mode": policy["mode"],
            "policyId": policy["policyId"],
        }
    )
    ready_read, ready_write = os.pipe()
    os.set_inheritable(ready_read, True)
    os.set_inheritable(ready_write, False)
    parent = os.getpid()
    root = os.fork()
    if root == 0:
        os.close(ready_write)
        child_main(parent, ready_read, argv)
        os._exit(127)
    os.close(ready_read)
    signal.signal(signal.SIGTERM, lambda _signum, _frame: os._exit(128 + signal.SIGTERM))

    def abandon(reason: str) -> int:
        _close_quiet(ready_write)
        try:
            os.kill(root, signal.SIGKILL)
        except OSError:
            pass
        evidence.close(reason)
        return 127

    try:
        ptrace(PTRACE_SEIZE, root, 0, TRACE_OPTIONS)
        ptrace(PTRACE_INTERRUPT, root)
        while True:
            try:
                _pid, status = os.waitpid(root, WAIT_WALL)
                break
            except InterruptedError:
                continue
    except (OSError, ChildProcessError):
        return abandon("ptrace unavailable")
    if not os.WIFSTOPPED(status) or event_of(status) != PTRACE_EVENT_STOP:
        return abandon("ptrace unavailable")
    try:
        os.write(ready_write, b"\n")
        os.close(ready_write)
    except OSError:
        return abandon("ptrace unavailable")
    cont(root, 0)
    code = Supervisor(root, policy, evidence).run()
    evidence.close()
    return code


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--decide-only":
        return decide_only()
    if argv and argv[0] == "--seccomp-decision":
        if len(argv) != 3:
            sys.stderr.write("command mediator: arch and syscall number are required\n")
            return 127
        try:
            action = execute_seccomp_program(int(argv[1], 0), int(argv[2], 0))
        except ValueError:
            sys.stderr.write("command mediator: arch and syscall number are required\n")
            return 127
        names = {
            SECCOMP_RET_KILL_PROCESS: "KILL",
            SECCOMP_RET_TRACE: "TRACE",
            SECCOMP_RET_ALLOW: "ALLOW",
        }
        sys.stdout.write(names.get(action, "KILL") + "\n")
        return 0
    policy_path = ""
    evidence_path = ""
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--":
            index += 1
            break
        if item == "--policy" and index + 1 < len(argv):
            policy_path = argv[index + 1]
            index += 2
            continue
        if item == "--evidence" and index + 1 < len(argv):
            evidence_path = argv[index + 1]
            index += 2
            continue
        sys.stderr.write(f"command mediator: unknown argument\n")
        return 127
    workload = argv[index:]
    if policy_path == "" or evidence_path == "" or not workload:
        sys.stderr.write("command mediator: policy, evidence, and a command are required\n")
        return 127
    with open(policy_path, encoding="utf-8") as handle:
        raw_policy = json.load(handle)
    if not isinstance(raw_policy, dict):
        sys.stderr.write("command mediator: policy must be an object\n")
        return 127
    try:
        policy = normalize_policy(raw_policy)
    except ValueError as error:
        sys.stderr.write(f"command mediator: {error}\n")
        return 127
    return supervise(policy, evidence_path, workload)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(0)
    except Exception as error:  # noqa: BLE001 — last-resort fail closed
        if os.environ.get("NITELY_MEDIATOR_DEBUG") == "1":
            import traceback
            traceback.print_exc()
        sys.stderr.write(f"command mediator: {error.__class__.__name__}\n")
        sys.exit(127)
