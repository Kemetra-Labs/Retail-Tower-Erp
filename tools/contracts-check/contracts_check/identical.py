"""Copies of one file that must stay byte-identical (RT-868 scope 1c, OBS-1 golden vectors)."""

import hashlib
import pathlib

from .findings import FAIL, OK, Finding


def check_group(repo, group):
    repo = pathlib.Path(repo)
    name, paths = group["name"], group["paths"]
    if len(paths) < 2:
        return [Finding("identical", name, FAIL, "needs at least two paths to compare")]
    digests, findings = {}, []
    for path in paths:
        try:
            digests[path] = hashlib.sha256((repo / path).read_bytes()).hexdigest()
        except OSError as exc:
            findings.append(Finding("identical", name, FAIL, f"{path} unreadable: {exc.strerror or exc}"))
    if findings:
        return findings
    if len(set(digests.values())) != 1:
        detail = ", ".join(f"{p} sha256={d[:12]}" for p, d in digests.items())
        return [Finding("identical", name, FAIL, f"copies differ: {detail}")]
    return [Finding("identical", name, OK,
                    f"{len(paths)} copies identical (sha256={next(iter(digests.values()))[:12]})")]
