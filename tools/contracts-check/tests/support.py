"""Test-only helpers: temporary git repositories, a fake oasdiff and the pinned real one."""

import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import textwrap

CC_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = CC_ROOT.parents[1]


def real_oasdiff():
    """The pinned oasdiff from CONTRACTS_CHECK_OASDIFF, else one on PATH, else None."""
    path = os.environ.get("CONTRACTS_CHECK_OASDIFF") or shutil.which("oasdiff")
    return path if path and os.access(path, os.X_OK) else None


class TempRepo:
    """A throwaway git repository; files are written then committed on demand."""

    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="cc-test-")
        self.root = pathlib.Path(self._tmp.name)
        self.git("init", "-q")

    def close(self):
        self._tmp.cleanup()

    def git(self, *args, stdin=None):
        proc = subprocess.run(["git", "-C", str(self.root), *args], input=stdin, capture_output=True, check=True)
        return proc.stdout.decode().strip()

    def write(self, rel, content):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            content = textwrap.dedent(content)
            path.write_text(content, encoding="utf-8")
        else:
            path.write_bytes(content)
        return path

    def blob(self, content):
        """Store `content` in the object store (not the tree) and return its blob id."""
        data = content.encode() if isinstance(content, str) else content
        return self.git("hash-object", "-w", "--stdin", stdin=data)


def fake_oasdiff(directory, breaking_exit=0, breaking_out="[]", changelog_exit=0, changelog_out="[]"):
    """An executable standing in for oasdiff: canned JSON per mode, chosen exit codes."""
    script = pathlib.Path(directory) / "fake-oasdiff"
    for name, value in (("breaking.json", breaking_out), ("changelog.json", changelog_out)):
        (pathlib.Path(directory) / name).write_text(value, encoding="utf-8")
    script.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        here="$(dirname "$0")"
        case "$1" in
          breaking) cat "$here/breaking.json"; exit {breaking_exit} ;;
          changelog) cat "$here/changelog.json"; exit {changelog_exit} ;;
        esac
        exit 99
        """), encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script
