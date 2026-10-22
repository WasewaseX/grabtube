#!/usr/bin/env python3
"""Double-fork daemonizer — the sandbox's session teardown kills everything
still attached to the tool shell's process tree; a properly daemonized child
(intermediate parent exits immediately, ppid=1, own session) survives.

Usage: python3 scripts/daemonize.py <cmd> [args...]
"""
import os
import sys


def daemonize_and_exec(cmd: list[str]) -> None:
    pid = os.fork()
    if pid == 0:
        # first child: new session, then fork again so the child can never
        # reacquire a controlling terminal
        os.setsid()
        pid2 = os.fork()
        if pid2 == 0:
            devnull = os.open("/dev/null", os.O_RDWR)
            os.dup2(devnull, 0)
            os.dup2(devnull, 1)
            os.dup2(devnull, 2)
            if devnull > 2:
                os.close(devnull)
            os.execvp(cmd[0], cmd)
            os._exit(127)
        os._exit(0)
    os.waitpid(pid, 0)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: daemonize.py <cmd> [args...]", file=sys.stderr)
        sys.exit(2)
    daemonize_and_exec(sys.argv[1:])
    print(f"daemonized: {' '.join(sys.argv[1:])}")
