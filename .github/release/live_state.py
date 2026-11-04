#!/usr/bin/env python3
"""G9 and the writers of the durable lab live-state record, the SSM parameter /rt/lab/live-state (RT-1084).

The record names what each lab product runs: the Backend-Core release, the Console release and the ERP
image digest with its commit. It is read by the deploy-system-lab.yml preflight (`read`, with the
read-only state role) and written by every live lab deploy with the deploy role: `begin` marks the run
`inflight` before any host document is sent, `finish` records what the run's own ledger proves.

Fail closed, with no exception: a missing, unreadable, malformed or unknown-schema record, a product
that is `dirty` or still `inflight`, a state read or write that fails, and a record that changed
between two reads all stop the run. `finish` never infers success: only a step the ledger shows as
finished makes a product `ok` (with the version the ledger names); a step that failed and may have
reached its host makes it `dirty`; only a failure that provably stopped before the host (G8's own rule,
live_check.facts) leaves the product as it was. A record left `inflight` or `dirty` is cleared by a
successful deploy of that product, or by the owner after reading the hosts (system/releases/README.md).

SSM has no compare-and-set. The shared `deploy-aws-lab` concurrency lock serialises the workflows; a
manual write outside it is detected as a changed version or digest on the next read.

Stdlib only; the only network access is the `aws` CLI. Exit 0 = done, 1 = refused or failed.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time

import live_check
import system_gate
import system_ledger

PARAM = "/rt/lab/live-state"
REGION = "us-east-1"
SCHEMA = "retail-tower/lab-live-state@1"
MAX_BYTES = 4096
AWS_TIMEOUT = 30
ATTEMPTS = 3
PRODUCTS = ("backend", "console", "erp")
WORKFLOWS = ("deploy-system-lab.yml", "deploy-lab.yml", "deploy-console-lab.yml", "deploy-erp-lab.yml")
KIND_WORKFLOW = {"system": WORKFLOWS[0], "backend": WORKFLOWS[1], "console": WORKFLOWS[2], "erp": WORKFLOWS[3]}
STEP_PRODUCT = {"backup": "backend", "backend": "backend", "console": "console", "erp": "erp"}
SYSTEM_NAME = re.compile(r"^lab-[0-9]{4}\.[0-9]{2}\.[0-9]+$")
TIME = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_PATH = re.compile(r"^system/releases/lab-[0-9]{4}\.[0-9]{2}\.[0-9]+\.json$")


class StateError(Exception):
    """The record cannot be trusted or written; the run must stop."""


class AwsError(StateError):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind  # not-found | denied | transient


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def one_line(text, limit=300):
    return " ".join(str(text).split())[:limit]


def digest_of(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- the record

def exact(data, required, optional, where):
    if not isinstance(data, dict):
        raise StateError(f"{where} is not an object")
    keys = set(data)
    if not set(required) <= keys or not keys <= set(required) | set(optional):
        raise StateError(f"{where} must have the keys {sorted(required)} (and optionally {sorted(optional)}), not {sorted(keys)}")


def positive_int(value, where):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise StateError(f"{where} is not a positive integer")


def matches(pattern, value, where):
    if not isinstance(value, str) or not pattern.match(value):
        raise StateError(f"{where} is malformed")


def check_product(name, item):
    where = f"products.{name}"
    exact(item, ("runId", "at", "state") + (("digest", "sha") if name == "erp" else ("release", "sha")), ("reason",), where)
    if name == "erp":
        matches(DIGEST, item["digest"], f"{where}.digest")
    else:
        field = "backendCore" if name == "backend" else "adminConsole"
        matches(system_gate.FIELDS[field]["release"], item["release"], f"{where}.release")
    matches(system_gate.SHA, item["sha"], f"{where}.sha")
    positive_int(item["runId"], f"{where}.runId")
    matches(TIME, item["at"], f"{where}.at")
    if item["state"] not in ("ok", "dirty"):
        raise StateError(f"{where}.state must be ok or dirty")
    reason = item.get("reason")
    if (item["state"] == "dirty") != (reason is not None):
        raise StateError(f"{where}: a reason goes with state dirty, and only with it")
    if reason is not None and (not isinstance(reason, str) or not reason.strip() or len(reason) > 300):
        raise StateError(f"{where}.reason is not a short text")


def parse_record(text):
    """The record in `text`, validated field by field. Raises StateError on anything else."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_BYTES:
        raise StateError(f"the record is not text of at most {MAX_BYTES} bytes")
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise StateError(f"the record is not JSON ({exc.__class__.__name__})") from exc
    exact(data, ("schema", "updatedAt", "writer", "system", "products"), ("note", "inflight"), "the record")
    if data["schema"] != SCHEMA:
        raise StateError(f"the record schema is not {SCHEMA}")
    matches(TIME, data["updatedAt"], "updatedAt")
    writer = data["writer"]
    exact(writer, ("workflow", "runId", "sha"), (), "writer")
    if writer["workflow"] not in WORKFLOWS:
        raise StateError("writer.workflow is not a lab deploy workflow")
    positive_int(writer["runId"], "writer.runId")
    matches(system_gate.SHA, writer["sha"], "writer.sha")
    if data["system"] is not None:
        matches(SYSTEM_NAME, data["system"], "system")
    if "note" in data and (not isinstance(data["note"], str) or len(data["note"]) > 200):
        raise StateError("note is not a short text")
    exact(data["products"], PRODUCTS, (), "products")
    for name in PRODUCTS:
        check_product(name, data["products"][name])
    inflight = data.get("inflight")
    if inflight is not None:
        exact(inflight, ("workflow", "runId", "startedAt", "products"), (), "inflight")
        if inflight["workflow"] not in WORKFLOWS:
            raise StateError("inflight.workflow is not a lab deploy workflow")
        positive_int(inflight["runId"], "inflight.runId")
        matches(TIME, inflight["startedAt"], "inflight.startedAt")
        products = inflight["products"]
        if (not isinstance(products, list) or not products or len(set(products)) != len(products)
                or any(item not in PRODUCTS for item in products)):
            raise StateError("inflight.products is not a non-empty list of products, once each")
    return data


def unresolved(record):
    """Products a run left in doubt: dirty, or inflight (a run started and never recorded its end)."""
    held = {name for name in PRODUCTS if record["products"][name]["state"] == "dirty"}
    inflight = record.get("inflight")
    return sorted(held | set(inflight["products"] if inflight else ()))


def doubt_reasons(record):
    out = []
    inflight = record.get("inflight")
    if inflight:
        out.append(f"{inflight['workflow']} run {inflight['runId']} marked {', '.join(inflight['products'])} inflight at "
                   f"{inflight['startedAt']} and never recorded its end")
    for name in PRODUCTS:
        item = record["products"][name]
        if item["state"] == "dirty":
            out.append(f"{name} is dirty: {item['reason']}")
    return out


def identity(name, item):
    return (item["digest"], item["sha"]) if name == "erp" else item["release"]


def names_manifest(record, manifest):
    """True when the record's versions are the ones the manifest values name."""
    values = system_ledger.values(manifest)
    expected = {"backend": values["backend_release"], "console": values["console_release"],
                "erp": (values["erp_digest"], values["erp_sha"])}
    return all(identity(name, record["products"][name]) == expected[name] for name in PRODUCTS)


def resolve(record, root, given=""):
    """The one manifest file (system/releases/lab-*.json) that names the recorded versions."""
    found = []
    for path in sorted(pathlib.Path(root, "system", "releases").glob("lab-*.json")):
        relative = f"system/releases/{path.name}"
        if not MANIFEST_PATH.match(relative):
            continue
        try:
            if names_manifest(record, system_ledger.load_manifest(path)):
                found.append(relative)
        except (OSError, ValueError, KeyError, TypeError):
            continue  # a manifest that does not read is not a candidate; G1 judges the chosen one
    if given:
        if given not in found:
            raise StateError(f"current_manifest {given} does not name the recorded versions (the record matches "
                             f"{', '.join(found) or 'no manifest'})")
        return given
    named = f"system/releases/{record['system']}.json" if record["system"] else None
    if named in found:
        return named
    if len(found) == 1:
        return found[0]
    raise StateError("no manifest names the recorded versions" if not found else
                     f"more than one manifest names the recorded versions ({', '.join(found)}); pass current_manifest to choose")


# ---------------------------------------------------------------- SSM (the aws CLI)

def run_aws(argv, timeout=AWS_TIMEOUT):
    argv = [shutil.which(argv[0]) or argv[0]] + list(argv[1:])
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as exc:
        return 127, "", f"{exc.__class__.__name__}"
    return proc.returncode, proc.stdout, proc.stderr


class Ssm:
    """get-parameter and put-parameter of one String parameter, with bounded retries and read-back."""

    def __init__(self, param=PARAM, region=REGION, runner=run_aws, sleep=time.sleep, attempts=ATTEMPTS):
        self.param, self.region, self.runner, self.sleep, self.attempts = param, region, runner, sleep, attempts

    def call(self, *args, attempts=None):
        argv = ["aws", "ssm", *args, "--region", self.region, "--output", "json"]
        attempts = attempts or self.attempts
        for attempt in range(attempts):
            code, out, err = self.runner(argv)
            if code == 0:
                try:
                    return json.loads(out)
                except ValueError as exc:
                    raise AwsError("transient", "the aws CLI answered with something that is not JSON") from exc
            if "ParameterNotFound" in err:
                raise AwsError("not-found", f"{self.param} does not exist (ParameterNotFound)")
            if "AccessDenied" in err or "not authorized" in err:
                raise AwsError("denied", f"access to {self.param} was denied")
            if attempt + 1 < attempts:
                self.sleep(2 ** attempt)
        raise AwsError("transient", f"the aws CLI failed {attempts} time(s) ({one_line(err, 120) or 'no message'})")

    def get(self):
        answer = self.call("get-parameter", "--name", self.param)
        item = answer.get("Parameter") if isinstance(answer, dict) else None
        if (not isinstance(item, dict) or item.get("Type") != "String" or not isinstance(item.get("Value"), str)
                or isinstance(item.get("Version"), bool) or not isinstance(item.get("Version"), int)):
            raise AwsError("transient", f"{self.param} is not a String parameter with a version")
        return item["Version"], item["Value"]

    def put_once(self, text):
        """One write, never retried here: a retry of a write is decided after reading the record back.
        The text starts with `{`, so the CLI never reads it as file:// or http://."""
        return self.call("put-parameter", "--name", self.param, "--type", "String", "--overwrite", "--value", text, attempts=1)

    def put_checked(self, text, before_version, before_text):
        """Write `text` over the record read as (before_version, before_text); returns the new version.

        A write that errors may still have landed, so each failure is followed by a read: the intended
        text means it landed (the version is evidence), the unchanged record means it did not (one more
        try, bounded), anything else means another writer changed the record and the run stops."""
        if len(text.encode("utf-8")) > MAX_BYTES:
            raise StateError(f"the new record is larger than {MAX_BYTES} bytes")
        last = "no attempt"
        for attempt in range(self.attempts):
            try:
                self.put_once(text)
            except AwsError as exc:
                if exc.kind == "denied":
                    raise
                last = str(exc)
            try:
                version, seen = self.get()
            except AwsError as exc:
                raise StateError(f"the write of {self.param} is ambiguous: its read-back failed ({exc})") from exc
            if seen == text:
                return version
            if seen == before_text and version == before_version:
                if attempt + 1 < self.attempts:
                    self.sleep(2 ** attempt)
                continue
            raise StateError(f"{self.param} changed to another value (version {version}) during the write; nothing more was written")
        raise StateError(f"{self.param} could not be written in {self.attempts} attempts ({last})")


# ---------------------------------------------------------------- the three commands

def gate_line(path, text):
    if path:
        target = pathlib.Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(text + "\n")


def cmd_read(args, ssm):
    """Preflight: read, validate, resolve the one current manifest. G9 line to the gates file; outputs to stdout."""
    try:
        version, text = ssm.get()
        record = parse_record(text)
        doubts = doubt_reasons(record)
        if doubts:
            raise StateError("; ".join(doubts) + " (runbook, system/releases/README.md: reconcile the host first)")
        manifest = resolve(record, args.root, args.given)
    except StateError as exc:
        gate_line(args.gates_file, f"G9 FAIL: record: {one_line(exc)}")
        print(f"::error::G9 record: {one_line(exc)}", file=sys.stderr)
        return 1
    digest = digest_of(text)
    if args.out_dir:
        out = pathlib.Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "record.json").write_text(text, encoding="utf-8", newline="\n")
    source = "given" if args.given else "resolved from the record"
    gate_line(args.gates_file, f"G9 pass: record: {ssm.param} version {version} (sha256 {digest[:12]}) is valid, has no dirty or "
                               f"inflight product, and names {manifest} ({source})")
    sys.stdout.write(f"manifest={manifest}\nstate_version={version}\nstate_sha256={digest}\nmanifest_source={'given' if args.given else 'record'}\n")
    return 0


def products_of(args):
    if args.product:
        return [args.product]
    steps = system_ledger.parse_run_steps(args.run_steps)
    return [name for name in PRODUCTS if any(STEP_PRODUCT[step] == name for step in steps)]


def cmd_begin(args, ssm):
    """Live job, before any host document: re-validate, then mark the run inflight (fail closed)."""
    workflow = KIND_WORKFLOW[args.kind]
    version, text = ssm.get()
    record = parse_record(text)
    if args.expect_version is not None and (version != args.expect_version or digest_of(text) != args.expect_sha256):
        raise StateError(f"the record changed since the preflight read it (version {args.expect_version} -> {version}); run a new dry run")
    held = unresolved(record)
    products = products_of(args)
    allowed = set(products) if args.kind != "system" else set()
    if not set(held) <= allowed:
        raise StateError("a previous run left " + ", ".join(held) + " in doubt (" + "; ".join(doubt_reasons(record)) +
                         "); only a successful deploy of exactly that product, or the owner after reading the hosts, clears it")
    new = json.loads(text)
    # A marker left by an earlier run (killed runner, lost finish) is replaced by this run's marker, so the
    # doubt it stood for moves into the product itself: it becomes dirty, and only a ledger that proves a
    # deploy can make it ok again. Otherwise a recovery run that fails before the host would clear it.
    old = record.get("inflight")
    for name in (old["products"] if old else ()):
        if new["products"][name]["state"] == "ok":
            new["products"][name]["state"] = "dirty"
            new["products"][name]["reason"] = one_line(f"{old['workflow']} run {old['runId']} marked it inflight at {old['startedAt']} and never recorded its end")
    new["writer"] = {"workflow": workflow, "runId": args.run_id, "sha": args.sha}
    new["updatedAt"] = now()
    new["inflight"] = {"workflow": workflow, "runId": args.run_id, "startedAt": new["updatedAt"], "products": products}
    parse_record(json.dumps(new))
    after = ssm.put_checked(json.dumps(new, separators=(",", ":")), version, text)
    write_evidence(args.out_dir, "state-begin.json", {"param": ssm.param, "runId": args.run_id, "products": products,
                                                        "before": {"version": version, "sha256": digest_of(text)}, "afterVersion": after})
    sys.stdout.write(f"begin_version={after}\n")
    return 0


def write_evidence(out_dir, name, data):
    if out_dir:
        out = pathlib.Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")


def outcome_of(kind, ledger, run_id):
    """({product: (value, at)} proven deployed, {product: reason} that may have changed its host)."""
    run = {"created_at": ledger.get("generatedAt") or now(), "id": run_id}
    try:
        events, incidents = live_check.facts(kind, [(run, ledger)])
    except (live_check.LiveError, KeyError, TypeError, ValueError, AttributeError) as exc:
        return {}, {"*": f"its ledger could not be read ({exc.__class__.__name__}: {one_line(exc, 150)})"}
    deployed = {product: value for _, product, value, _ in events}
    doubtful = {}
    for _, products, label, touched, why in incidents:
        if touched:
            for product in products:
                doubtful[product] = one_line(f"{label} {why}")
    return deployed, doubtful


def tag_commit(release, root="."):
    """The commit a release tag names, from the checked-out history (the preflight verified the tag)."""
    try:
        proc = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "--quiet", f"refs/tags/{release}^{{commit}}"],
                              capture_output=True, text=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StateError(f"git could not resolve {release} ({exc.__class__.__name__})") from exc
    value = proc.stdout.strip()
    if proc.returncode != 0 or not system_gate.SHA.match(value):
        raise StateError(f"the tag {release} does not resolve to a commit here")
    return value


def ledger_commit(kind, name, ledger):
    """The release commit a product ledger itself records (the Backend-Core and Console ledgers do), else None."""
    try:
        value = ledger["release"]["sha"] if kind == "backend" else ledger["target"]["sha"] if kind == "console" else None
    except (KeyError, TypeError):
        value = None
    return value if isinstance(value, str) and system_gate.SHA.match(value) else None


def apply_finish(record, kind, ledger, run_id, sha, manifest=None, commit_of=lambda name, release: tag_commit(release)):
    """The record after the run: ok for what the ledger proves deployed, dirty for what may have changed, else as it was."""
    inflight = record["inflight"]
    deployed, doubtful = outcome_of(kind, ledger, run_id)
    at = ledger.get("generatedAt") if isinstance(ledger.get("generatedAt"), str) and TIME.match(ledger.get("generatedAt", "")) else now()
    new = json.loads(json.dumps(record))
    for name in inflight["products"]:
        item = new["products"][name]
        if name in deployed:
            value = deployed[name]
            target = {"digest": value[0], "sha": value[1]} if name == "erp" else {"release": value, "sha": commit_of(name, value)}
            new["products"][name] = {**target, "runId": run_id, "at": at, "state": "ok"}
        elif name in doubtful or "*" in doubtful:
            item["state"], item["reason"] = "dirty", doubtful.get(name) or doubtful["*"]
            item["runId"], item["at"] = run_id, at
        # else: the run provably never reached the host; the product is exactly as it was (a dirty one stays dirty)
    new["inflight"] = None
    new["writer"] = {"workflow": KIND_WORKFLOW[kind], "runId": run_id, "sha": sha}
    new["updatedAt"] = now()
    states = [new["products"][name]["state"] for name in PRODUCTS]
    new["system"] = manifest["system"] if manifest and all(state == "ok" for state in states) and names_manifest(new, manifest) else None
    return new


def cmd_finish(args, ssm):
    """Live job, after the ledger: record the outcome. Only the run that marked the record may clear its marker."""
    version, text = ssm.get()
    record = parse_record(text)
    inflight = record.get("inflight")
    if not inflight or inflight["runId"] != args.run_id or inflight["workflow"] != KIND_WORKFLOW[args.kind] or version != args.begin_version:
        raise StateError(f"the record is no longer the one this run marked (version {args.begin_version} -> {version}); it was left as it is")
    evidence = {"param": ssm.param, "runId": args.run_id, "before": {"version": version, "sha256": digest_of(text)}, "result": "not written"}
    try:
        ledger = json.loads(pathlib.Path(args.ledger).read_text(encoding="utf-8"))
        manifest = system_ledger.load_manifest(args.manifest) if args.manifest else None
        new = apply_finish(record, args.kind, ledger, args.run_id, args.sha, manifest,
                           lambda name, release: ledger_commit(args.kind, name, ledger) or tag_commit(release, args.root))
        intended = json.dumps(new, separators=(",", ":"))
        parse_record(intended)
        evidence["intended"] = new
        after = ssm.put_checked(intended, version, text)
    except (StateError, OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        # The marker stays set (the next preflight refuses); what failed, and the record meant to be written
        # when it was computed, stay next to the ledger.
        evidence["result"] = f"FAILED: {one_line(exc)}"
        write_evidence(args.out_dir, "state-finish.json", evidence)
        raise
    evidence.update({"afterVersion": after, "result": "written"})
    write_evidence(args.out_dir, "state-finish.json", evidence)
    sys.stdout.write(f"finish_version={after}\n")
    return 0


def main(argv=None, ssm=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    read = sub.add_parser("read")
    read.add_argument("--root", default=".")
    read.add_argument("--given", default="")
    read.add_argument("--out-dir", default="")
    read.add_argument("--gates-file", default="")

    for name in ("begin", "finish"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--kind", required=True, choices=sorted(KIND_WORKFLOW))
        cmd.add_argument("--run-id", required=True, type=int)
        cmd.add_argument("--sha", required=True)
        cmd.add_argument("--out-dir", default="")
        if name == "begin":
            cmd.add_argument("--run-steps", default="")
            cmd.add_argument("--product", choices=PRODUCTS)
            cmd.add_argument("--expect-version", type=int)
            cmd.add_argument("--expect-sha256")
        else:
            cmd.add_argument("--ledger", required=True)
            cmd.add_argument("--begin-version", required=True, type=int)
            cmd.add_argument("--manifest", default="")
            cmd.add_argument("--root", default=".")

    args = parser.parse_args(argv)
    ssm = ssm or Ssm()
    try:
        if args.command == "read":
            if args.given and not MANIFEST_PATH.match(args.given):
                print("live-state: current_manifest must be system/releases/lab-YYYY.MM.N.json", file=sys.stderr)
                return 2
            return cmd_read(args, ssm)
        if not system_gate.SHA.match(args.sha):
            print("live-state: --sha must be 40 hex", file=sys.stderr)
            return 2
        if args.command == "begin":
            if (args.kind == "system") == bool(args.product) or (args.kind == "system" and not args.run_steps):
                print("live-state: begin takes --run-steps for the system workflow and --product for a product workflow", file=sys.stderr)
                return 2
            if args.kind != "system" and args.product != args.kind:
                print("live-state: --product must be the workflow's own product", file=sys.stderr)
                return 2
            if (args.expect_version is None) != (args.expect_sha256 is None) or (args.expect_sha256 and not SHA256.match(args.expect_sha256)):
                print("live-state: --expect-version and --expect-sha256 go together", file=sys.stderr)
                return 2
            return cmd_begin(args, ssm)
        return cmd_finish(args, ssm)
    except (StateError, OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(f"::error::live-state: {one_line(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
