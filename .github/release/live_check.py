#!/usr/bin/env python3
"""G8 of deploy-system-lab.yml: refuse a current_manifest that no longer matches the live lab.

Each per-product lab deploy (deploy-lab.yml, deploy-console-lab.yml, deploy-erp-lab.yml) and each
system deploy (deploy-system-lab.yml) uploads a live ledger artifact. The newest of those that
deployed a product is what the lab runs. This reads them with the read-only `actions: read`
token (no AWS), compares them with the current manifest and prints `G8 pass|FAIL: <detail>` lines
in the format of system_ledger.py's gates file, so a stale manifest is refused in the preflight,
before the live job and before the lab-02 backup.

Per product the live value is the value of the newest event, whichever workflow it came from. A
system run that failed part-way counts only for the steps that finished. A newer run that did not
deploy is an incident: it refuses when its ledger shows the host may have changed (a Backend-Core
run past its migrate gate, any ERP run that held or failed after its stop gate, a Console run that
swapped), and is a note when its ledger shows no host was reached. The owner clears a refusal with
a successful deploy of that product (runbook, system/releases/README.md). Fails closed: a missing,
expired or malformed ledger, a truncated run list or a missing token is a FAIL.

Stdlib only; the only network call is `gh api`. Exit 0 = pass, 1 = FAIL.
"""
import argparse
import datetime
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import zipfile

import system_gate
import system_ledger

MAX_ARTIFACT_BYTES = 1024 * 1024
SCAN_LIMIT = 100
PRODUCTS = ("backend", "console", "erp")
# product -> (workflow file, live ledger artifact prefix, ledger kind)
SPECS = {
    "backend": ("deploy-lab.yml", "deploy-lab-live-ledger", "rt842-lab-live-ledger"),
    "console": ("deploy-console-lab.yml", "deploy-console-lab-live-ledger", "rt1007-console-lab-live-ledger"),
    "erp": ("deploy-erp-lab.yml", "deploy-erp-lab-live-ledger", "rt927-erp-lab-live-ledger"),
    "system": ("deploy-system-lab.yml", "deploy-system-lab-live-ledger", system_ledger.LIVE_KIND),
}
# Gates a document passes (or fails at) before it has changed anything on its host. A run whose
# every gate is in here, with no swap and no revert, left lab-01 and lab-03 as they were. The Backend-Core
# backup document only writes a dump on lab-02, so its gates are listed with the Backend-Core ones.
SAFE_GATES = {
    "backend": {"inputs", "lock", "G-Host", "G-Backup", "fetch", "backup-config",
                "backup-preconditions", "backup-dump", "backup-restore-rehearsal", "preconditions", "dump", "restore-rehearsal"},
    "console": {"inputs", "lock", "G-Host", "fetch", "check"},
    "erp": {"inputs", "lock", "check"},
}
# What ssm-run.sh writes to failure.txt when it stops before the document is sent. Any other reason
# (a cancel or timeout during the poll, "live job stopped before or during ...") can leave the document
# running on the host, so it is never read as "not sent".
PRE_SEND = ("no single Online SSM node", "describe-instance-information failed", "send-command was refused", "no parameters file")
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
SKIPPED = re.compile(r"\(outcome: (skipped|not-run)\)$")
ERP_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class LiveError(Exception):
    """The live state cannot be read or does not make sense: a G8 failure, never a pass."""


class GhApi:
    """Read-only GitHub REST calls through the gh CLI (GH_TOKEN with actions: read)."""

    def __init__(self, repo):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repo or ""):
            raise LiveError("the repository name is not OWNER/REPO")
        self.repo = repo

    def _run(self, path, params):
        args = ["gh", "api", "-X", "GET", f"repos/{self.repo}/{path}"]
        for key, value in params.items():
            args += ["-f", f"{key}={value}"]
        proc = subprocess.run(args, capture_output=True, check=False, timeout=120)
        if proc.returncode != 0:
            raise LiveError(f"GitHub refused {path}: {proc.stderr.decode('utf-8', 'replace').strip()[:200]}")
        return proc.stdout

    def runs(self, workflow, limit):
        params = {"status": "completed", "branch": "main", "event": "workflow_dispatch", "per_page": str(limit)}
        return json.loads(self._run(f"actions/workflows/{workflow}/runs", params))

    def artifacts(self, run_id):
        return json.loads(self._run(f"actions/runs/{run_id}/artifacts", {"per_page": "100"}))["artifacts"]

    def jobs(self, run_id):
        return json.loads(self._run(f"actions/runs/{run_id}/jobs", {"per_page": "100"}))["jobs"]

    def download(self, artifact_id):
        return self._run(f"actions/artifacts/{artifact_id}/zip", {})


def parse_time(text):
    return datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))


def read_ledger(blob, run_id, key):
    """ledger.json from the artifact zip, checked to be this run's live ledger of this workflow."""
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            info = archive.getinfo("ledger.json")
            if info.file_size > MAX_ARTIFACT_BYTES:
                raise LiveError(f"run {run_id}: ledger.json is larger than {MAX_ARTIFACT_BYTES} bytes")
            ledger = json.loads(archive.read(info).decode("utf-8"))
    except (zipfile.BadZipFile, KeyError, ValueError) as exc:
        raise LiveError(f"run {run_id}: the live ledger is unreadable ({type(exc).__name__})") from exc
    if not isinstance(ledger, dict) or ledger.get("kind") != SPECS[key][2] or ledger.get("mode") != "live":
        raise LiveError(f"run {run_id}: the artifact is not a {SPECS[key][2]} live ledger")
    if not str(ledger.get("runUrl", "")).endswith(f"/actions/runs/{run_id}"):
        raise LiveError(f"run {run_id}: the ledger does not name its own run")
    if not isinstance(ledger.get("outcome"), str):
        raise LiveError(f"run {run_id}: the ledger has no outcome")
    return ledger


def live_job_started(api, run_id):
    return any(str(job.get("name", "")).startswith("live") and job.get("started_at") and job.get("conclusion") != "skipped"
               for job in api.jobs(run_id))


def reject_rerun(run, workflow):
    """A re-run keeps the id and the created_at of its first attempt, so its ledger cannot be ordered or trusted."""
    if run.get("run_attempt", 1) != 1:
        raise LiveError(f"{workflow} run {run.get('id')} is a re-run (attempt {run.get('run_attempt')}); read its ledger by hand")


def scan(api, key, limit):
    """Newest-first records [(run, ledger or None)] of one workflow, up to and including its newest
    run that deployed. Dry runs leave no live ledger and are skipped."""
    workflow, prefix, _ = SPECS[key]
    listing = api.runs(workflow, limit)
    runs = [run for run in listing["workflow_runs"] if run.get("head_branch") == "main" and run.get("status") == "completed"]
    runs.sort(key=lambda run: (parse_time(run["created_at"]), run["id"]), reverse=True)
    records = []
    for run in runs:
        run_id = run["id"]
        if not isinstance(run_id, int):
            raise LiveError(f"{workflow}: a run has no numeric id")
        found = [art for art in api.artifacts(run_id) if art.get("name") == f"{prefix}-{run_id}"]
        if not found:
            if run.get("conclusion") in ("failure", "cancelled", "timed_out") and live_job_started(api, run_id):
                reject_rerun(run, workflow)
                records.append((run, None))
            continue
        reject_rerun(run, workflow)
        art = found[0]
        if art.get("expired") or art.get("size_in_bytes", 0) > MAX_ARTIFACT_BYTES:
            raise LiveError(f"{workflow} run {run_id}: its live ledger is expired or too large to read")
        ledger = read_ledger(api.download(art["id"]), run_id, key)
        records.append((run, ledger))
        if ledger["outcome"] == "deployed":
            return records
    if listing.get("total_count", 0) > len(listing["workflow_runs"]):
        raise LiveError(f"{workflow}: more than {limit} runs and no deployed live ledger in the newest {limit}")
    return records


def boundary_info(boundary):
    """(gate, text) of a failure boundary: a dict from an RT_FAIL line, a string, or None."""
    if isinstance(boundary, dict):
        gate, text = boundary.get("gate"), boundary.get("reason")
    elif isinstance(boundary, str):
        match = re.match(r"^RT_GATE ([A-Za-z0-9_.-]+)=fail", boundary)
        gate, text = (match.group(1) if match else None), boundary
    else:
        return None, None
    return (gate if isinstance(gate, str) else None), (text if isinstance(text, str) else None)


def untouched(product, gates, changed, boundary):
    """True only when the run provably stopped before its host changed (gates, swap, revert, boundary)."""
    safe = SAFE_GATES[product]
    if changed or any(not isinstance(gate, str) or gate not in safe for gate in gates):
        return False
    gate, text = boundary_info(boundary)
    if gate is not None:
        return gate in safe
    return bool(text and SKIPPED.search(text))


def tag_of(product, ledger):
    """The value a deployed per-product ledger says the lab runs, checked against the manifest patterns."""
    try:
        if product == "backend":
            value, pattern = ledger["release"]["tag"], system_gate.FIELDS["backendCore"]["release"]
        elif product == "console":
            value, pattern = ledger["target"]["release"], system_gate.FIELDS["adminConsole"]["release"]
        else:
            digest, sha = ledger["target"]["digest"], ledger["target"]["sha"]
            if not (isinstance(digest, str) and ERP_DIGEST.match(digest) and isinstance(sha, str) and system_gate.SHA.match(sha)):
                raise LiveError(f"{ledger.get('runUrl')}: the ERP digest or commit is malformed")
            return (digest, sha)
    except (KeyError, TypeError) as exc:
        raise LiveError(f"{ledger.get('runUrl')}: the ledger lacks its deployed {product} version") from exc
    if not (isinstance(value, str) and pattern.match(value)):
        raise LiveError(f"{ledger.get('runUrl')}: the {product} version is malformed")
    return value


def gate_names(gates):
    if not isinstance(gates, list):
        raise LiveError("a ledger's gates are not a list")
    names = [item.get("gate") if isinstance(item, dict) else None for item in gates]
    return [name if isinstance(name, str) and NAME.match(name) else None for name in names]


def facts(key, records):
    """(events, incidents) of one workflow. event: (time, product, value, label). incident: (time, products, label, touched)."""
    events, incidents = [], []
    for run, ledger in records:
        when, run_id = parse_time(run["created_at"]), run["id"]
        label = f"{SPECS[key][0]} run {run_id}"
        if ledger is None:
            incidents.append((when, PRODUCTS, label, True, "its live job started but left no ledger"))
        elif key == "system":
            system_facts(ledger, when, label, events, incidents)
        elif ledger["outcome"] == "deployed":
            events.append((when, key, tag_of(key, ledger), label))
        else:
            gates = gate_names(ledger.get("gates"))
            changed = bool(ledger.get("revert")) or bool(ledger.get("swap")) or ledger["outcome"] == "held"
            safe = untouched(key, gates, changed, ledger.get("failureBoundary"))
            incidents.append((when, (key,), label, not safe, f"ended {ledger['outcome']}"))
    return events, incidents


def fail_gate_of(lines):
    """The gate a document's own output says failed: `RT_FAIL gate=<gate>` or the ERP `RT_GATE <gate>=fail`."""
    for line in lines:
        match = isinstance(line, str) and (re.match(r"^RT_FAIL gate=([A-Za-z0-9_.-]+)", line) or re.match(r"^RT_GATE ([A-Za-z0-9_.-]+)=fail", line))
        if match:
            return match.group(1)
    return None


def system_facts(ledger, when, label, events, incidents):
    steps = ledger.get("steps")
    if not isinstance(steps, list):
        raise LiveError(f"{label}: the system ledger has no steps")
    system = ledger.get("system")
    label = f"{label} ({system})" if isinstance(system, str) and NAME.match(system) else label
    for step in steps:
        name, state = step.get("step"), step.get("state")
        if name not in PRODUCTS and name != "backup":
            raise LiveError(f"{label}: unknown step")
        if name == "backup":
            continue
        if state not in ("ok", "failed", "not-run"):
            raise LiveError(f"{label}: the {name} step has an unknown state")
        lines = step.get("lines") or []
        if state == "ok":
            target = step.get("target") or {}
            if name == "backend":
                value = target.get("release")
                pattern = system_gate.FIELDS["backendCore"]["release"]
            elif name == "console":
                value = target.get("release")
                pattern = system_gate.FIELDS["adminConsole"]["release"]
            else:
                image = target.get("image")
                value = (image.split("@", 1)[1], target.get("sha")) if isinstance(image, str) and "@" in image else None
                pattern = None
            valid = (isinstance(value, str) and pattern.match(value)) if pattern else (
                value is not None and ERP_DIGEST.match(value[0]) and isinstance(value[1], str) and system_gate.SHA.match(value[1]))
            if not valid:
                raise LiveError(f"{label}: the {name} step has no valid deployed version")
            events.append((when, name, value, label))
        elif state == "failed":
            fail_gate = fail_gate_of(lines)
            # RT_OUTCOME=failed is what the ERP document prints on every stop(), also at its inputs and check
            # gates, so only held and deployed count as a change here.
            changed = any(isinstance(line, str) and line.startswith(("RT_SWAP", "RT_REVERT", "RT_OUTCOME=held", "RT_OUTCOME=deployed")) for line in lines)
            gates = gate_names(step.get("gates") or [])
            reason = (ledger.get("failure") or {}).get("reason")
            if not lines and step.get("ssmStatus") is None and isinstance(reason, str) and any(reason.startswith(f"{name}: {text}") for text in PRE_SEND):
                safe = True  # ssm-run.sh stopped before it sent the document
            else:
                safe = untouched(name, gates, changed, {"gate": fail_gate} if fail_gate else None)
            incidents.append((when, (name,), label, not safe, f"failed at its {name} step"))


def decide(manifest, events, incidents):
    """[(ok, text)] G8 lines for the products of a current manifest."""
    expected = {"backend": manifest["backend_release"], "console": manifest["console_release"],
                "erp": (manifest["erp_digest"], manifest["erp_sha"])}
    out = []
    for product in PRODUCTS:
        mine = sorted((event for event in events if event[1] == product), key=lambda event: event[0], reverse=True)
        if not mine:
            out.append((False, f"{product}: no deployed live ledger found, so the live version is unknown"))
            continue
        when, _, value, label = mine[0]
        shown = value if isinstance(value, str) else f"{value[0]} at {value[1]}"
        wanted = expected[product] if isinstance(expected[product], str) else f"{expected[product][0]} at {expected[product][1]}"
        if value == expected[product]:
            out.append((True, f"{product}: the live lab runs {shown} ({label}), as the current manifest says"))
        else:
            out.append((False, f"{product}: the live lab runs {shown} ({label}), but the current manifest names {wanted}"))
        for at, products, incident_label, touched, why in sorted(incidents, key=lambda item: item[0], reverse=True):
            if product not in products or at <= when:
                continue
            if touched:
                out.append((False, f"{product}: {incident_label} {why} after the last deploy and may have changed the host; "
                                   "the owner reconciles it, then a successful deploy of the product clears this (runbook step 1)"))
            else:
                out.append((True, f"{product}: note, {incident_label} {why} before it reached a host (ignored)"))
    return out


def check(api, manifest_path, limit=SCAN_LIMIT):
    manifest = system_ledger.values(system_ledger.load_manifest(manifest_path))
    events, incidents = [], []
    for key in SPECS:
        found_events, found_incidents = facts(key, scan(api, key, limit))
        events += found_events
        incidents += found_incidents
    return decide(manifest, events, incidents)


def main(argv=None, api=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--current-manifest", required=True)
    parser.add_argument("--gates-file", required=True)
    parser.add_argument("--scan-limit", type=int, default=SCAN_LIMIT)
    args = parser.parse_args(argv)
    try:
        lines = check(api or GhApi(args.repo), args.current_manifest, args.scan_limit)
    except (LiveError, OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        lines = [(False, f"the live lab could not be read: {exc}")]
    # One line per result: a detail (an API error text, say) can never start a second `G8 pass:` line.
    text = "".join(f"G8 {'pass' if ok else 'FAIL'}: {' '.join(detail.split())}\n" for ok, detail in lines)
    sys.stdout.write(text)
    with pathlib.Path(args.gates_file).open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return 0 if all(ok for ok, _ in lines) else 1


if __name__ == "__main__":
    sys.exit(main())
