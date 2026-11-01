#!/usr/bin/env python3
"""Manifest values and the system ledger of deploy-system-lab.yml (RT-1031, plan RT-1029).

deploy-system-lab.yml deploys one system version (system/releases/<system>.json, RT-1030) through
four owner-created SSM documents, in this order, stopping at the first failure (D3):

  backup   RT-BackendLabBackup  lab-02   the database backup the Backend step needs
  backend  RT-BackendLabDeploy  lab-01
  console  RT-ConsoleLabDeploy  lab-01
  erp      RT-ErpLabDeploy      lab-03

Three subcommands, so the workflow keeps no value or ledger logic in inline shell:

  values  prints KEY=VALUE lines (for $GITHUB_OUTPUT) for a manifest, each value already checked by
          the G1 patterns of system_gate.py, so it is safe to use as a command argument;
  plan    writes the planned ledger of the preflight (outcome `planned`, or `refused`);
  final   writes the live ledger from the files .github/release/ssm-run.sh left in --live-dir:
          the outcome (`deployed` or `failed-at:<step>`), each step's prior and target version, the
          strict RT_* lines, and the manual rollback inputs for every step that completed.

Stdlib only, fails closed: a manifest that does not pass G1 is an error (exit 2). Exit 0 = written.
"""
import argparse
import datetime
import json
import pathlib
import re
import sys

import system_gate

STEPS = (
    ("backup", "RT-BackendLabBackup", "lab-02"),
    ("backend", "RT-BackendLabDeploy", "lab-01"),
    ("console", "RT-ConsoleLabDeploy", "lab-01"),
    ("erp", "RT-ErpLabDeploy", "lab-03"),
)
ERP_SERVICES = ("backend", "frontend", "websocket", "scheduler", "queue-short", "queue-long")
RULES = ("G1", "G2", "G3", "G4", "G5", "G6", "G7")
GATE_LINE = re.compile(r"^(G[1-7]) (pass|FAIL|unverified): (.*)$")
GATE_RESULTS = re.compile(r"^(G[1-7]=(pass|FAIL|unverified|not-run))( G[1-7]=(pass|FAIL|unverified|not-run))*$")
PLAN_KIND = "rt1031-system-lab-planned-ledger"
LIVE_KIND = "rt1031-system-lab-live-ledger"


def load_manifest(path):
    """The manifest at path, checked against G1; ValueError when it does not pass."""
    path = pathlib.Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    problem = system_gate.check_shape(data, path.name)
    if problem:
        raise ValueError(f"{path}: {problem}")
    return data


def values(data):
    """The manifest fields the workflow passes to documents and checks."""
    return {
        "system": data["system"],
        "backend_release": data["backendCore"]["release"],
        "console_release": data["adminConsole"]["release"],
        "erp_image": data["erpnext"]["image"],
        "erp_digest": data["erpnext"]["image"].split("@", 1)[1],
        "erp_sha": data["erpnext"]["sha"],
        "pos_build": data["pos"]["build"],
    }


def gate_results(text):
    """{rule: pass | FAIL | unverified | not-run} from `G<n> <result>: <detail>` lines. FAIL wins."""
    found = {}
    for line in text.splitlines():
        match = GATE_LINE.match(line.strip())
        if not match:
            continue
        rule, result = match.group(1), match.group(2)
        previous = found.get(rule)
        if previous == "FAIL" or result == "FAIL":
            found[rule] = "FAIL"
        elif previous == "unverified" or result == "unverified":
            found[rule] = "unverified"
        else:
            found[rule] = "pass"
    return {rule: found.get(rule, "not-run") for rule in RULES}


def parse_gate_string(text):
    if not GATE_RESULTS.fullmatch(text or ""):
        raise ValueError("--gates must look like 'G1=pass G2=pass ...'")
    return dict(item.split("=") for item in text.split(" "))


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_lines(path):
    path = pathlib.Path(path)
    if not path.is_file():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def kv(line):
    return dict(part.split("=", 1) for part in line.split(" ")[1:] if "=" in part)


def first(lines, prefix):
    return next((line for line in lines if line.startswith(prefix)), None)


def step_records(live_dir):
    """One record per document, in deploy order: ok, failed (the first that did not finish) or not-run."""
    live = pathlib.Path(live_dir)
    records, failed = [], False
    for name, document, host in STEPS:
        done = (live / f"{name}.ok").is_file()
        lines = read_lines(live / f"{name}.lines")
        status = (live / f"{name}.status").read_text(encoding="utf-8").strip() if (live / f"{name}.status").is_file() else None
        if done:
            state = "ok"
        elif not failed:
            state, failed = "failed", True
        else:
            state = "not-run"
        records.append({"step": name, "document": document, "host": host, "state": state, "ssmStatus": status, "lines": lines})
    return records


def attach_versions(records, target, current):
    """Prior and target version of each step. Backend and Console report their prior from the host."""
    for record in records:
        name, lines = record["step"], record["lines"]
        if name == "backup":
            record["prior"], record["target"] = None, kv(first(lines, "RT_BACKUP ") or "RT_BACKUP")
        elif name == "backend":
            line = first(lines, "RT_PRIOR ")
            record["prior"] = kv(line) if line else None
            record["target"] = {"release": target["backend_release"]}
        elif name == "console":
            line = first(lines, "RT_PRIOR ")
            record["prior"] = kv(line) if line else None
            record["target"] = {"release": target["console_release"]}
        else:
            record["prior"] = {"sha": current["erp_sha"], "image": current["erp_image"],
                               "source": "operator-declared by the current manifest; the document checks it on lab-03"}
            record["target"] = {"sha": target["erp_sha"], "image": target["erp_image"]}
        record["gates"] = [item for item in (gate_of(line) for line in lines) if item]
    return records


def gate_of(line):
    parts = line.split(" ")
    if parts[0] != "RT_GATE":
        return None
    if len(parts) == 3:
        return {"gate": parts[1], "result": parts[2]}
    if len(parts) == 2 and "=" in parts[1]:  # the ERP document: RT_GATE <name>=<result>
        gate, result = parts[1].split("=", 1)
        return {"gate": gate, "result": result}
    return None


def manual_rollback(records, target, current, jira_key, rollback_allowed, erp_class):
    """The exact inputs to undo each completed step by hand (D3), in the order they can run:
    ERP, then Backend-Core, then the Console. The Console comes last because RT-ConsoleLabDeploy's
    G-Host refuses until lab-01 runs the BackendRelease it is given (the current one)."""
    done = {record["step"]: record for record in records if record["state"] == "ok"}
    out = []
    if "erp" in done:
        out.append({
            "step": "erp", "workflow": "deploy-erp-lab.yml",
            "inputs": {
                "target_digest": current["erp_digest"], "target_sha": current["erp_sha"], "current_sha": target["erp_sha"],
                "current_images": json.dumps({service: target["erp_image"] for service in ERP_SERVICES}, separators=(",", ":")),
                "jira_key": jira_key, "hold": False, "save_current_image": False, "dry_run": False},
            "note": f"the forward deploy's rollback class was {erp_class or 'unknown'}; restore.sh on lab-03 is owner-run when it was `restore`",
        })
    if "backend" in done:
        backup = next((r["target"] for r in records if r["step"] == "backup"), None)
        out.append({
            "step": "backend", "workflow": "deploy-lab.yml",
            "inputs": {"backend_release": current["backend_release"], "current_release": target["backend_release"],
                       "target": "lab-01", "jira_key": jira_key, "dry_run": False},
            "note": ("the forward deploy added no migration: an app-only rollback is allowed" if rollback_allowed
                     else "the forward deploy migrated the database: an app-only rollback is NOT allowed, restore from the backup first"),
            "backup": backup,
        })
    if "console" in done:
        out.append({
            "step": "console", "workflow": "deploy-console-lab.yml",
            "inputs": {"console_release": current["console_release"], "backend_release": current["backend_release"],
                       "jira_key": jira_key, "dry_run": False},
            "note": "run after the Backend-Core rollback: the document checks that lab-01 runs backend_release",
        })
    for order, item in enumerate(out, 1):
        item["order"] = order
    return out


def failure_of(failed, reason):
    """The failure boundary. The Backend-Core and Console documents revert themselves; the ERP
    document can stop after its swap with the workers down, so its failure says where to look."""
    if not failed:
        return None
    out = {"step": failed["step"], "reason": reason}
    if failed["step"] == "erp":
        out["note"] = ("lab-03 may be left with the workers down: read RT-ErpLabDeploy's ledger on lab-03, then "
                       "redeploy (deploy-erp-lab.yml) or run deploy/lab/restore.sh as its rollback class requires")
    return out


def render_summary(ledger):
    title = "System lab deploy " + ("plan" if ledger["kind"] == PLAN_KIND else "live")
    lines = [f"## {title}: {ledger['outcome'].upper()}", "",
             f"{ledger['system']} over {ledger['currentSystem']}, {ledger['jiraKey']}. Gates: "
             + ", ".join(f"{rule} {result}" for rule, result in ledger["gates"].items()) + "."]
    for record in ledger.get("steps", []):
        lines += ["", f"### {record['step']} ({record['document']} on {record['host']}): {record['state']}", "```", *record["lines"], "```"]
    if ledger.get("failure"):
        lines += ["", f"Failure boundary: {ledger['failure']['reason']}"]
        if ledger["failure"].get("note"):
            lines.append(ledger["failure"]["note"])
    for refusal in ledger.get("refusals", []):
        lines.append(f"- refused: {refusal}")
    for item in ledger.get("manualRollback", []):
        lines += ["", f"Manual rollback {item['order']}, {item['step']}: run `{item['workflow']}` with `{json.dumps(item['inputs'])}`. {item['note']}"]
    return "\n".join(lines) + "\n"


def write(out_dir, ledger):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "ledger.json").write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8", newline="\n")
    (out / "summary.md").write_text(render_summary(ledger), encoding="utf-8", newline="\n")


def base_ledger(args, kind, target_data, current_data):
    return {
        "schemaVersion": 1, "kind": kind, "system": target_data["system"], "currentSystem": current_data["system"],
        "jiraKey": args.jira_key, "actor": args.actor, "runUrl": args.run_url, "generatedAt": args.generated_at or now(),
        "environment": "aws-lab", "manifest": target_data, "currentManifest": current_data,
        "order": [{"step": n, "document": d, "host": h} for n, d, h in STEPS],
    }


def plan(args):
    target_data, current_data = load_manifest(args.manifest), load_manifest(args.current_manifest)
    gates_text = pathlib.Path(args.gates_file).read_text(encoding="utf-8") if args.gates_file and pathlib.Path(args.gates_file).is_file() else ""
    results = gate_results(gates_text)
    refusals = [f"{rule} failed" for rule, result in results.items() if result == "FAIL"]
    if args.failure:
        refusals.append(args.failure)
    ledger = base_ledger(args, PLAN_KIND, target_data, current_data)
    ledger.update({
        "mode": "live" if args.live else "dry-run",
        "outcome": "refused" if refusals else "planned", "refusals": refusals, "gates": results,
        "backend": {"rollbackAllowed": args.rollback_allowed == "true"},
        "erp": {"rollbackClass": args.erp_rollback_class or None},
        "environmentGate": args.environment_gate,
    })
    write(args.out, ledger)
    return 1 if refusals else 0


def final(args):
    target_data, current_data = load_manifest(args.manifest), load_manifest(args.current_manifest)
    target, current = values(target_data), values(current_data)
    records = attach_versions(step_records(args.live_dir), target, current)
    failed = next((r for r in records if r["state"] == "failed"), None)
    reason = None
    if failed:
        reason_lines = read_lines(pathlib.Path(args.live_dir) / "failure.txt")
        reason = reason_lines[0] if reason_lines else f"live job stopped before or during {failed['document']}"
    rollback_allowed = args.rollback_allowed == "true"
    ledger = base_ledger(args, LIVE_KIND, target_data, current_data)
    ledger.update({
        "mode": "live",
        "outcome": f"failed-at:{failed['step']}" if failed else "deployed",
        "gates": parse_gate_string(args.gates), "rollbackAllowed": rollback_allowed, "erpRollbackClass": args.erp_rollback_class or None,
        "failure": failure_of(failed, reason),
        "steps": records,
        "manualRollback": manual_rollback(records, target, current, args.jira_key, rollback_allowed, args.erp_rollback_class),
    })
    write(args.out, ledger)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    vals = sub.add_parser("values", help="print KEY=VALUE lines for a manifest")
    vals.add_argument("--manifest", required=True)
    vals.add_argument("--prefix", required=True, choices=["target", "current"])

    for name in ("plan", "final"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--manifest", required=True)
        cmd.add_argument("--current-manifest", required=True)
        cmd.add_argument("--jira-key", required=True)
        cmd.add_argument("--actor", default="")
        cmd.add_argument("--run-url", default="")
        cmd.add_argument("--generated-at")
        cmd.add_argument("--rollback-allowed", choices=["true", "false"], default="false")
        cmd.add_argument("--erp-rollback-class", default="", choices=["", "image-only", "restore"])
        cmd.add_argument("--out", required=True)
        if name == "plan":
            cmd.add_argument("--gates-file")
            cmd.add_argument("--failure", default="")
            cmd.add_argument("--live", action="store_true")
            cmd.add_argument("--environment-gate", default="unverified", choices=["reviewed", "unverified"])
        else:
            cmd.add_argument("--live-dir", required=True)
            cmd.add_argument("--gates", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "values":
            for key, value in values(load_manifest(args.manifest)).items():
                print(f"{args.prefix}_{key}={value}")
            return 0
        return plan(args) if args.command == "plan" else final(args)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"system-ledger: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
