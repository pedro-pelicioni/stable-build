#!/usr/bin/env python3
"""Run a command on a pseudo-terminal and answer its prompts, for test/install/roundtrip.sh.

  tty-drive.py --transcript FILE [--timeout SEC] [--expect TEXT --send REPLY]... -- CMD [ARG]...

The command gets the pty as its controlling terminal (so /dev/tty opens) and as stdin, stdout and
stderr. Each --expect TEXT waits until TEXT appears in the output after the previous match, then
types the paired --send REPLY followed by Enter. Pairs are used in order. Everything the terminal
showed (prompts, echoed answers, output) is written to FILE with CR LF turned into LF.

Exit status: the command's own, or 124 when an expected text did not appear (or the command did not
finish) within --timeout seconds; the command is then killed. Uses only the standard library.
"""
import argparse
import os
import pty
import select
import signal
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--expect", action="append", default=[])
    ap.add_argument("--send", action="append", default=[])
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd or len(a.expect) != len(a.send):
        ap.error("need a command and as many --send as --expect")
    script = list(zip(a.expect, a.send))

    pid, fd = pty.fork()
    if pid == 0:  # child: the pty is its controlling terminal
        try:
            os.execvp(cmd[0], cmd)
        finally:
            os._exit(127)

    out = b""
    seen = 0  # output before this offset has already matched an expectation
    deadline = time.monotonic() + a.timeout
    status = None
    timed_out = False
    while True:
        if script:
            want = script[0][0].encode()
            at = out.find(want, seen)
            if at >= 0:
                seen = at + len(want)
                os.write(fd, script[0][1].encode() + b"\r")
                script.pop(0)
                continue
        left = deadline - time.monotonic()
        if left <= 0:
            timed_out = True
            break
        r, _, _ = select.select([fd], [], [], min(left, 0.2))
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:  # EIO on Linux once the child has exited
                chunk = b""
            if not chunk:
                break
            out += chunk
        else:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
                # drain what is left
                try:
                    while select.select([fd], [], [], 0.1)[0]:
                        chunk = os.read(fd, 4096)
                        if not chunk:
                            break
                        out += chunk
                except OSError:
                    pass
                break

    if timed_out or script:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if status is None:
        _, status = os.waitpid(pid, 0)
    os.close(fd)

    with open(a.transcript, "wb") as f:
        f.write(out.replace(b"\r\n", b"\n").replace(b"\r", b""))
    if timed_out or script:
        missing = script[0][0] if script else "(command still running)"
        sys.stderr.write("tty-drive: timed out waiting for: %s\n" % missing)
        return 124
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 128 + os.WTERMSIG(status)


if __name__ == "__main__":
    sys.exit(main())
