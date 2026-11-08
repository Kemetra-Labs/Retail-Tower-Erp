"""Post a pr-review report to a GitHub PR as one COMMENT review with inline comments.

Usage:
    python post_review.py --pr N --review review.md [--repo OWNER/NAME] [--dry-run]

Each finding block that starts with `### <n>. [<Severity>] ...` becomes an inline comment
anchored at the first `path:line` (or `path:a-b`) in its heading. The text before the first
finding becomes the review body. Findings whose path/line is not part of the PR diff are
folded into the body instead (GitHub rejects inline comments outside the diff).
Never approves or requests changes: event is always COMMENT.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

FINDING = re.compile(r"^### \d+\. \[(Critical|Major|Minor|Trivial)\].*$", re.M)
LOCATION = re.compile(r"`([^`\s:]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?")


def gh(*args: str, stdin: str | None = None) -> str:
    result = subprocess.run(["gh", *args], input=stdin, capture_output=True,
                            text=True, encoding="utf-8")
    if result.returncode != 0:
        sys.exit(f"[ERROR] gh {' '.join(args[:3])}: {result.stderr.strip()}")
    return result.stdout


def json_pages(text: str) -> list:
    """Merge `gh api --paginate` output, which prints one JSON array per page back to back."""
    decoder, items, pos = json.JSONDecoder(), [], 0
    while True:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            return items
        page, pos = decoder.raw_decode(text, pos)
        items.extend(page)


def diff_lines(repo: str, pr: int) -> dict[str, set[int]]:
    """Right-side line numbers present in the PR diff, per file."""
    files = json_pages(gh("api", f"repos/{repo}/pulls/{pr}/files?per_page=100", "--paginate"))
    commentable: dict[str, set[int]] = {}
    for f in files:
        lines, new = set(), 0
        for row in (f.get("patch") or "").splitlines():
            hunk = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", row)
            if hunk:
                new = int(hunk.group(1))
                continue
            if row.startswith(("-", "\\")):  # removed line, or "\ No newline at end of file"
                continue
            lines.add(new)
            new += 1
        commentable[f["filename"]] = lines
    return commentable


def split(review: str) -> tuple[str, list[tuple[str, str, int | None, int | None]]]:
    starts = [m.start() for m in FINDING.finditer(review)]
    body = review[: starts[0]] if starts else review
    findings = []
    for i, start in enumerate(starts):
        block = review[start: starts[i + 1] if i + 1 < len(starts) else len(review)]
        block = re.split(r"^## (Questions|Not checked|Not reviewed)", block, flags=re.M)[0].strip()
        heading = block.splitlines()[0]
        loc = LOCATION.search(heading)
        if loc:
            end = int(loc.group(3)) if loc.group(3) else int(loc.group(2))
            findings.append((block, loc.group(1), int(loc.group(2)), end))
        else:
            findings.append((block, "", None, None))
    return body.strip(), findings


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--review", required=True)
    ap.add_argument("--repo")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    repo = a.repo or gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()
    body, findings = split(open(a.review, encoding="utf-8").read())
    allowed = diff_lines(repo, a.pr)
    comments, folded = [], []
    for block, path, start, end in findings:
        lines = allowed.get(path, set())
        anchor = next((n for n in range(end or 0, (start or 0) - 1, -1) if n in lines), None) if path else None
        if anchor is None:
            folded.append(block)
        else:
            comments.append({"path": path, "line": anchor, "side": "RIGHT", "body": block})
    if folded:
        body += "\n\n---\n**Findings outside the diff:**\n\n" + "\n\n---\n\n".join(folded)
    payload = {"event": "COMMENT", "body": body or "PR review", "comments": comments}

    print(f"[INFO] {repo}#{a.pr}: {len(comments)} inline, {len(folded)} folded into body")
    for c in comments:
        print(f"  - {c['path']}:{c['line']}  {c['body'].splitlines()[0][:90]}".encode("ascii", "replace").decode())
    if a.dry_run:
        print("[DRY-RUN] nothing posted")
        return
    gh("api", f"repos/{repo}/pulls/{a.pr}/reviews", "--method", "POST", "--input", "-",
       stdin=json.dumps(payload))
    print("[OK] review posted")


if __name__ == "__main__":
    main()
