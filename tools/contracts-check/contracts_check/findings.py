"""Finding records and the text / Markdown report.

`fail` findings make the check exit 1. `drift` findings are listed but never fail: a
non-breaking contract change or a stale version string in a mirror. `ok` records what was
compared, so a green run still shows its evidence."""

from dataclasses import dataclass

FAIL, DRIFT, OK = "fail", "drift", "ok"
_ORDER = {FAIL: 0, DRIFT: 1, OK: 2}


@dataclass(frozen=True)
class Finding:
    check: str      # pins | connector | identical
    subject: str    # e.g. "POS pos-sales/sales.yaml"
    status: str     # fail | drift | ok
    message: str


def failed(findings):
    return any(f.status == FAIL for f in findings)


def _sorted(findings):
    return sorted(findings, key=lambda f: (_ORDER[f.status], f.check, f.subject, f.message))


def text_report(findings):
    lines = [f"{f.status.upper():5} [{f.check}] {f.subject}: {f.message}" for f in _sorted(findings)]
    counts = {s: sum(1 for f in findings if f.status == s) for s in (FAIL, DRIFT, OK)}
    verdict = "FAILED" if counts[FAIL] else "passed"
    lines.append(f"contracts/check {verdict}: {counts[FAIL]} fail, {counts[DRIFT]} drift, {counts[OK]} ok")
    return "\n".join(lines) + "\n"


def _cell(text):
    return text.replace("|", "\\|").replace("\n", " ")


def markdown_report(findings):
    counts = {s: sum(1 for f in findings if f.status == s) for s in (FAIL, DRIFT, OK)}
    out = ["## contracts/check", "",
           f"**{'FAILED' if counts[FAIL] else 'passed'}**: {counts[FAIL]} fail, "
           f"{counts[DRIFT]} drift (reported, not failing), {counts[OK]} ok", ""]
    for status, title in ((FAIL, "Failures"), (DRIFT, "Drift (non-breaking)"), (OK, "Compared")):
        rows = [f for f in _sorted(findings) if f.status == status]
        if not rows:
            continue
        out += [f"### {title}", "", "| check | subject | detail |", "| --- | --- | --- |"]
        out += [f"| {f.check} | {_cell(f.subject)} | {_cell(f.message)} |" for f in rows]
        out.append("")
    return "\n".join(out) + "\n"
