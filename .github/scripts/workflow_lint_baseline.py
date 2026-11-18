#!/usr/bin/env python3
"""Baseline gate for the workflow linters (RT-1459, audit A-14).

actionlint and zizmor (RT-1410) always exited 0, so a template injection, an excessive permission or
an unpinned action in a new workflow was printed and then merged. This script makes `workflow-lint`
fail on every finding that is not in `.github/workflow-lint-baseline.txt`, and on every baseline
entry that no longer occurs, so the baseline can only shrink (the rule of `boundary-todo.yaml`).

  workflow_lint_baseline.py generate --actionlint FILE --zizmor FILE      baseline text on stdout
  workflow_lint_baseline.py check --tool actionlint|zizmor --rc N --findings FILE \\
        --baseline FILE [--plain FILE] [--summary FILE]                   exit 0 equal, 1 a diff or a tool failure

`--findings` is the tool's JSON (`actionlint -format '{{json .}}'`, `zizmor --format json`); `--rc` is the
tool's exit code. A baseline line is `tool|file|rule|message`: the file is the workflow, the rule is the
audit (zizmor `ident`, actionlint `kind`) and the message has no line or column number, so an edit that
only moves a finding never churns the baseline. The same line may repeat; findings are counted, so a
second identical finding in a file is new. `#` lines and blank lines are comments.

Fail closed: a tool exit code that is not one of its documented "findings" codes, unreadable JSON, or a
missing baseline is a failure, never "no findings". Stdlib only, so it runs on the runner's system
Python with no setup step. Adding a line to the baseline is a policy change (`.github/**`) that the
policy approval covers; the intended edit is only ever a deletion.
"""
import argparse
import collections
import json
import re
import sys

TOOLS = ("actionlint", "zizmor")

# actionlint: 0 no findings, 1 findings; 2 usage and 3 fatal are failures. zizmor: 0 no findings,
# 10..14 findings by highest severity (10 none above the default, 11 informational ... 14 high); 1 and
# the rest are failures. Anything else is a tool that did not lint.
OK_CODES = {"actionlint": {0, 1}, "zizmor": {0, 10, 11, 12, 13, 14}}

HEADER = """\
# Workflow lint baseline (RT-1459, audit A-14). One line per known finding: tool|file|rule|message.
# `workflow-lint` fails on a finding that is not listed here AND on a line that no longer occurs, so
# this file can only shrink: delete a line when you fix its finding; never add one to get a PR green
# (a new line needs the policy approval of `.github/**`). Line numbers are not part of a line, so
# moving a finding does not change it; an identical finding repeated in a file is listed repeatedly.
# Regenerate after fixing (the tools are pinned in .github/workflows/workflow-lint.yml):
#   actionlint -no-color -format '{{json .}}' -ignore 'unexpected key "queue" for "concurrency" section' > al.json
#   zizmor --offline --no-progress --color never --quiet --format json .github/workflows > zz.json
#   python3 .github/scripts/workflow_lint_baseline.py generate --actionlint al.json --zizmor zz.json \\
#     > .github/workflow-lint-baseline.txt
"""

_SHELLCHECK_POSITION = re.compile(r"(SC\d+:[a-z]+):\d+:\d+:")


class LintInputError(Exception):
    """The tool output could not be read; never treated as "no findings"."""


def _clean(text):
    return " ".join(str(text).split())


def normalise_actionlint(findings):
    """`actionlint|file|kind|message` lines (the shellcheck line:col inside the script is dropped)."""
    lines = []
    for item in findings:
        message = _SHELLCHECK_POSITION.sub(r"\1:", _clean(item["message"]))
        lines.append(f"actionlint|{_clean(item['filepath'])}|{_clean(item['kind'])}|{message}")
    return lines


def _zizmor_file(finding):
    for location in finding.get("locations", []):
        symbolic = location.get("symbolic", {})
        if symbolic.get("kind") == "Primary":
            key = symbolic.get("key", {})
            for variant in key.values():
                path = variant.get("verbatim_path") or variant.get("given_path") or variant.get("slug")
                if path:
                    return _clean(path)
    raise LintInputError(f"zizmor finding {finding.get('ident')!r} has no primary file")


def _zizmor_message(finding):
    annotation = ""
    for location in finding.get("locations", []):
        symbolic = location.get("symbolic", {})
        if symbolic.get("kind") == "Primary":
            annotation = _clean(symbolic.get("annotation", ""))
            break
    description = _clean(finding.get("desc", ""))
    return f"{description}: {annotation}" if annotation else description


def normalise_zizmor(findings):
    """`zizmor|file|ident|desc: annotation` lines; findings the config already ignores are skipped."""
    lines = []
    for finding in findings:
        if finding.get("ignored"):
            continue
        lines.append(f"zizmor|{_zizmor_file(finding)}|{_clean(finding['ident'])}|{_zizmor_message(finding)}")
    return lines


NORMALISERS = {"actionlint": normalise_actionlint, "zizmor": normalise_zizmor}


def load_findings(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        raise LintInputError(f"cannot read the findings JSON {path}: {error}") from error
    if data is None:  # actionlint prints `null` for an empty list with a template format
        return []
    if not isinstance(data, list):
        raise LintInputError(f"{path} is not a JSON list of findings")
    return data


def normalise(tool, path):
    try:
        return NORMALISERS[tool](load_findings(path))
    except (KeyError, TypeError, AttributeError) as error:
        raise LintInputError(f"unexpected {tool} JSON shape in {path}: {error!r}") from error


def read_baseline(path, tool):
    """The baseline lines of one tool (comments and blank lines dropped)."""
    try:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read().splitlines()
    except OSError as error:
        raise LintInputError(f"cannot read the baseline {path}: {error}") from error
    entries = [line.strip() for line in raw if line.strip() and not line.lstrip().startswith("#")]
    for entry in entries:
        if entry.split("|", 1)[0] not in TOOLS or entry.count("|") < 3:
            raise LintInputError(f"malformed baseline line (want tool|file|rule|message): {entry[:120]}")
    return [entry for entry in entries if entry.startswith(tool + "|")]


def diff(current, baseline):
    """(new, stale): the findings above the baseline's count, and the baseline lines no longer found."""
    now, then = collections.Counter(current), collections.Counter(baseline)
    return sorted((now - then).elements()), sorted((then - now).elements())


def _fence(lines, limit=400):
    out = ["````"]  # four backticks: a workflow line that contains ``` cannot close the fence early
    out.extend(lines[:limit])
    if len(lines) > limit:
        out.append("... truncated; the full list is in the step log")
    out.append("````")
    return out


def render(tool, rc, current, baseline, new, stale, plain_lines):
    """The job summary: what fails first, then the counts, then the tool's own report."""
    out = []
    if new or stale:
        out.append(f"### {tool}: FAILED against the baseline ({len(new)} new, {len(stale)} stale)")
        out.append("")
    else:
        out.append(f"### {tool}: matches the baseline ({len(current)} known finding(s), exit {rc})")
        out.append("")
    if new:
        out.append(f"**{len(new)} new finding(s), not in `.github/workflow-lint-baseline.txt`.** Fix the workflow; do not add them to the baseline:")
        out.append("")
        out.extend(_fence(new))
        out.append("")
    if stale:
        out.append(f"**{len(stale)} stale baseline line(s): the finding no longer occurs.** Delete the line(s) from `.github/workflow-lint-baseline.txt` (the baseline only shrinks):")
        out.append("")
        out.extend(_fence(stale))
        out.append("")
    if plain_lines is not None:
        out.append(f"{tool} report (full output):")
        out.append("")
        out.extend(_fence(plain_lines))
    return out


def cmd_check(args):
    if args.rc not in OK_CODES[args.tool]:
        print(f"{args.tool} exited {args.rc}, which is not a lint result (want one of {sorted(OK_CODES[args.tool])}): failing closed", file=sys.stderr)
        return 1
    current = normalise(args.tool, args.findings)
    baseline = read_baseline(args.baseline, args.tool)
    new, stale = diff(current, baseline)
    if args.summary:
        plain = None
        if args.plain:
            with open(args.plain, encoding="utf-8", errors="replace") as handle:
                plain = handle.read().splitlines()
        with open(args.summary, "a", encoding="utf-8") as handle:
            handle.write("\n".join(render(args.tool, args.rc, current, baseline, new, stale, plain)) + "\n")
    for line in new:
        print(f"NEW      {line}")
    for line in stale:
        print(f"STALE    {line}")
    print(f"{args.tool}: {len(current)} finding(s), baseline {len(baseline)}, {len(new)} new, {len(stale)} stale")
    return 1 if new or stale else 0


def cmd_generate(args):
    lines = sorted(normalise("actionlint", args.actionlint) + normalise("zizmor", args.zizmor))
    sys.stdout.write(HEADER)
    for line in lines:
        sys.stdout.write(line + "\n")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("--tool", choices=TOOLS, required=True)
    check.add_argument("--rc", type=int, required=True)
    check.add_argument("--findings", required=True)
    check.add_argument("--baseline", required=True)
    check.add_argument("--plain")
    check.add_argument("--summary")
    check.set_defaults(run=cmd_check)
    generate = sub.add_parser("generate")
    generate.add_argument("--actionlint", required=True)
    generate.add_argument("--zizmor", required=True)
    generate.set_defaults(run=cmd_generate)
    args = parser.parse_args(argv)
    try:
        return args.run(args)
    except LintInputError as error:
        print(f"workflow-lint baseline: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
