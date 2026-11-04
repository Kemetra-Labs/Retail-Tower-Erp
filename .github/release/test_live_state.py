"""G9 and the live-state record writers (RT-1084): tests of live_state.py against a fake `aws` CLI.

The fake keeps one SSM String parameter in memory, with a version, and can fail, throttle, deny or land a
write and then report an error, so each fail-closed path is exercised without AWS. The seed is the
record the owner created on 2026-11-04 (lab-2026.11.3, version 1).
"""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import live_state
import system_ledger

ROOT = pathlib.Path(__file__).resolve().parents[2]
B_SHA, C_SHA = "8c72ed5e3436c6095704f97eceb6cb88349166cc", "07756dbc607bae73df5d1f9bc949074b2eb48aac"
OLD_B, OLD_C = "44a933a270d8f2e1f6410ef1eaa712e03c81e399", "683b0b56e12cec9890afbf5c7ccb81427fb77068"
DIGEST = "sha256:936f67e636021aa88e9fb15ff91134a2f73573b153f59c7d1017293313585415"
E_SHA = "9b9c1780b08b5a3a09fda7394d5dd10a6aab33c1"
RUN, OTHER_RUN, MAIN_SHA = 41800000001, 41800000002, "2cf86978f1266878129fab3c694fbd8c4a79070c"
COMMITS = {"backend-core/v0.5.0": B_SHA, "admin-console/v0.4.0": C_SHA, "backend-core/v0.4.0": OLD_B, "admin-console/v0.3.0": OLD_C}

SEED = {
    "schema": "retail-tower/lab-live-state@1", "updatedAt": "2026-11-03T23:40:14Z",
    "writer": {"workflow": "deploy-system-lab.yml", "runId": 41738798480, "sha": "82c2ae26a39ef0ded716d0a5f3d5f8726de33b4a"},
    "note": "one-time owner seed from live ledgers 41617142070 and 41738798480", "system": "lab-2026.11.3",
    "products": {
        "backend": {"release": "backend-core/v0.5.0", "sha": B_SHA, "runId": 41738798480, "at": "2026-11-03T23:40:14Z", "state": "ok"},
        "console": {"release": "admin-console/v0.4.0", "sha": C_SHA, "runId": 41738798480, "at": "2026-11-03T23:40:14Z", "state": "ok"},
        "erp": {"digest": DIGEST, "sha": E_SHA, "runId": 41617142070, "at": "2026-11-03T10:37:23Z", "state": "ok"},
    },
}


def dump(data):
    return json.dumps(data, separators=(",", ":"))


def before_upgrade():
    """The lab as lab-2026.11.2 left it: the record before the upgrade the ledgers below deploy."""
    data = json.loads(dump(SEED))
    data["system"] = "lab-2026.11.2"
    data["products"]["backend"].update(release="backend-core/v0.4.0", sha=OLD_B)
    data["products"]["console"].update(release="admin-console/v0.3.0", sha=OLD_C)
    return data


class FakeAws:
    """An in-memory SSM parameter behind the `aws` CLI's argv."""

    def __init__(self, text=None, version=1):
        self.exists, self.value, self.version = text is not None, text, version if text is not None else 0
        self.calls, self.get_errors, self.put_plan, self.on_get = [], [], [], None

    def __call__(self, argv):
        op = argv[2]
        self.calls.append(op)
        if op == "get-parameter":
            if self.on_get:
                self.on_get(self)
            if self.get_errors:
                code, err = self.get_errors.pop(0)
                return code, "", err
            if not self.exists:
                return 254, "", "An error occurred (ParameterNotFound) when calling the GetParameter operation"
            item = {"Name": live_state.PARAM, "Type": "String", "Value": self.value, "Version": self.version}
            return 0, json.dumps({"Parameter": item}), ""
        text = argv[argv.index("--value") + 1]
        mode = self.put_plan.pop(0) if self.put_plan else "ok"
        if mode == "error":
            return 255, "", "An error occurred (ThrottlingException) when calling the PutParameter operation"
        if mode == "denied":
            return 254, "", "An error occurred (AccessDeniedException) when calling the PutParameter operation"
        self.value, self.version, self.exists = text, self.version + 1, True
        if mode == "land-then-error":
            return 255, "", "connection reset by peer"
        return 0, json.dumps({"Version": self.version, "Tier": "Standard"}), ""

    def puts(self):
        return self.calls.count("put-parameter")


def ssm(aws):
    return live_state.Ssm(runner=aws, sleep=lambda seconds: None)


def main(argv, aws):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = live_state.main(argv, ssm=ssm(aws))
    return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------- ledgers, in the shapes the real runs uploaded

def sys_step(name, state, lines=(), status="Success", gates=(), target=None):
    return {"step": name, "document": "RT-" + name, "host": "lab", "state": state, "ssmStatus": status, "lines": list(lines),
            "gates": [{"gate": gate, "result": "pass"} for gate in gates], "target": target or {}}


def sys_ledger(backend="ok", console="ok", erp="skipped", failure=None, console_lines=(), console_gates=("G-Host", "fetch", "check"),
               console_status="Success"):
    manifest = system_ledger.load_manifest(ROOT / "system" / "releases" / "lab-2026.11.3.json")
    current = system_ledger.load_manifest(ROOT / "system" / "releases" / "lab-2026.11.2.json")
    steps = [
        sys_step("backup", "ok" if backend == "ok" else "not-run"),
        sys_step("backend", backend, status="Success" if backend == "ok" else None, target={"release": "backend-core/v0.5.0"}),
        sys_step("console", console, lines=console_lines, status=console_status if console != "not-run" else None,
                 gates=console_gates, target={"release": "admin-console/v0.4.0"}),
        sys_step("erp", erp, status=None, target={"image": manifest["erpnext"]["image"], "sha": E_SHA}),
    ]
    return {"schemaVersion": 1, "kind": system_ledger.LIVE_KIND, "mode": "live", "system": "lab-2026.11.3", "currentSystem": "lab-2026.11.2",
            "manifest": manifest, "currentManifest": current, "steps": steps, "failure": failure, "outcome": "deployed",
            "generatedAt": "2026-11-04T09:00:00Z", "runUrl": f"https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/{RUN}"}


def product_ledger(kind, outcome="deployed", gates=(), boundary=None, swap=False):
    base = {"mode": "live", "outcome": outcome, "generatedAt": "2026-11-04T09:00:00Z", "gates": [{"gate": gate} for gate in gates],
            "failureBoundary": boundary, "swap": swap, "revert": False,
            "runUrl": f"https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/{RUN}"}
    if kind == "backend":
        base.update(kind="rt842-lab-live-ledger", release={"tag": "backend-core/v0.5.0", "sha": B_SHA})
    elif kind == "console":
        base.update(kind="rt1007-console-lab-live-ledger", target={"release": "admin-console/v0.4.0", "sha": C_SHA})
    else:
        base.update(kind="rt927-erp-lab-live-ledger", target={"digest": DIGEST, "sha": E_SHA})
    return base


class Case(unittest.TestCase):
    def tmp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return pathlib.Path(directory.name)

    def stored(self, aws):
        return json.loads(aws.value)


# ---------------------------------------------------------------- the record

class Record(Case):
    def test_the_seed_the_owner_created_is_a_valid_record(self):
        record = live_state.parse_record(dump(SEED))
        self.assertEqual(live_state.unresolved(record), [])

    def test_every_malformation_is_refused(self):
        def changed(edit):
            data = json.loads(dump(SEED))
            edit(data)
            return dump(data)

        cases = {
            "not JSON": "{",
            "an array": "[]",
            "another schema": changed(lambda d: d.update(schema="retail-tower/lab-live-state@2")),
            "an unknown key": changed(lambda d: d.update(extra=1)),
            "a missing key": changed(lambda d: d.pop("system")),
            "a bad system name": changed(lambda d: d.update(system="lab-2026.11")),
            "a bad time": changed(lambda d: d.update(updatedAt="yesterday")),
            "a writer that is no lab workflow": changed(lambda d: d["writer"].update(workflow="release.yml")),
            "a short writer sha": changed(lambda d: d["writer"].update(sha="82c2ae26")),
            "a boolean run id": changed(lambda d: d["writer"].update(runId=True)),
            "a missing product": changed(lambda d: d["products"].pop("erp")),
            "an extra product": changed(lambda d: d["products"].update(pos={})),
            "a bad backend release": changed(lambda d: d["products"]["backend"].update(release="v0.5.0")),
            "a console release for the backend": changed(lambda d: d["products"]["backend"].update(release="admin-console/v0.4.0")),
            "a short ERP digest": changed(lambda d: d["products"]["erp"].update(digest="sha256:936f")),
            "an unknown state": changed(lambda d: d["products"]["console"].update(state="unknown")),
            "dirty without a reason": changed(lambda d: d["products"]["console"].update(state="dirty")),
            "a reason on an ok product": changed(lambda d: d["products"]["console"].update(reason="why")),
            "an empty inflight list": changed(lambda d: d.update(inflight={"workflow": "deploy-lab.yml", "runId": 1, "startedAt": "2026-11-04T09:00:00Z", "products": []})),
            "an inflight product twice": changed(lambda d: d.update(inflight={"workflow": "deploy-lab.yml", "runId": 1, "startedAt": "2026-11-04T09:00:00Z", "products": ["erp", "erp"]})),
            "an oversized record": changed(lambda d: d.update(note="x" * 200)) + " " * 5000,
        }
        for label, text in cases.items():
            with self.assertRaises(live_state.StateError, msg=label):
                live_state.parse_record(text)

    def test_dirty_and_inflight_products_are_in_doubt(self):
        data = json.loads(dump(SEED))
        data["products"]["console"].update(state="dirty", reason="a run changed the host")
        data["inflight"] = {"workflow": "deploy-system-lab.yml", "runId": 7, "startedAt": "2026-11-04T09:00:00Z", "products": ["backend"]}
        record = live_state.parse_record(dump(data))
        self.assertEqual(live_state.unresolved(record), ["backend", "console"])
        self.assertEqual(len(live_state.doubt_reasons(record)), 2)


class Resolve(Case):
    def test_the_seed_names_lab_2026_11_3(self):
        record = live_state.parse_record(dump(SEED))
        self.assertEqual(live_state.resolve(record, ROOT), "system/releases/lab-2026.11.3.json")
        self.assertEqual(live_state.resolve(record, ROOT, "system/releases/lab-2026.11.3.json"), "system/releases/lab-2026.11.3.json")

    def test_a_given_manifest_must_name_the_recorded_versions(self):
        record = live_state.parse_record(dump(SEED))
        with self.assertRaises(live_state.StateError) as caught:
            live_state.resolve(record, ROOT, "system/releases/lab-2026.11.2.json")
        self.assertIn("does not name the recorded versions", str(caught.exception))

    def test_versions_no_manifest_names_are_refused(self):
        data = json.loads(dump(SEED))
        data["products"]["backend"].update(release="backend-core/v9.9.9")
        with self.assertRaises(live_state.StateError):
            live_state.resolve(live_state.parse_record(dump(data)), ROOT)

    def test_two_matching_manifests_need_a_choice(self):
        root = self.tmp()
        releases = root / "system" / "releases"
        releases.mkdir(parents=True)
        source = json.loads((ROOT / "system" / "releases" / "lab-2026.11.3.json").read_text(encoding="utf-8"))
        for name in ("lab-2026.11.3", "lab-2026.12.0"):
            (releases / f"{name}.json").write_text(json.dumps({**source, "system": name}), encoding="utf-8")
        record = json.loads(dump(SEED))
        record["system"] = None
        parsed = live_state.parse_record(dump(record))
        with self.assertRaises(live_state.StateError) as caught:
            live_state.resolve(parsed, root)
        self.assertIn("more than one manifest", str(caught.exception))
        self.assertEqual(live_state.resolve(parsed, root, "system/releases/lab-2026.12.0.json"), "system/releases/lab-2026.12.0.json")
        record["system"] = "lab-2026.12.0"
        self.assertEqual(live_state.resolve(live_state.parse_record(dump(record)), root), "system/releases/lab-2026.12.0.json")


# ---------------------------------------------------------------- the preflight read (G9)

class Read(Case):
    def read(self, aws, given=""):
        directory = self.tmp()
        gates = directory / "plan" / "gates.txt"
        code, out, err = main(["read", "--root", str(ROOT), "--given", given, "--out-dir", str(directory / "state"), "--gates-file", str(gates)], aws)
        return code, out, err, (gates.read_text(encoding="utf-8") if gates.is_file() else ""), directory

    def test_a_valid_record_passes_G9_and_names_the_manifest(self):
        code, out, _, gates, directory = self.read(FakeAws(dump(SEED)))
        self.assertEqual(code, 0)
        self.assertEqual(dict(line.split("=", 1) for line in out.splitlines()), {
            "manifest": "system/releases/lab-2026.11.3.json", "state_version": "1",
            "state_sha256": live_state.digest_of(dump(SEED)), "manifest_source": "record"})
        self.assertRegex(gates, r"^G9 pass: record: /rt/lab/live-state version 1 \(sha256 [0-9a-f]{12}\) is valid")
        self.assertEqual((directory / "state" / "record.json").read_text(encoding="utf-8"), dump(SEED))

    def test_a_given_current_manifest_must_match_the_record(self):
        code, out, _, gates, _ = self.read(FakeAws(dump(SEED)), "system/releases/lab-2026.11.3.json")
        self.assertEqual((code, "manifest_source=given" in out), (0, True))
        code, out, err, gates, _ = self.read(FakeAws(dump(SEED)), "system/releases/lab-2026.11.2.json")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("G9 FAIL: record: current_manifest system/releases/lab-2026.11.2.json does not name the recorded versions", gates)

    def test_every_refusal_exits_1_with_a_G9_line_and_no_outputs(self):
        dirty = json.loads(dump(SEED))
        dirty["products"]["erp"].update(state="dirty", reason="run 5 may have changed lab-03")
        inflight = json.loads(dump(SEED))
        inflight["inflight"] = {"workflow": "deploy-lab.yml", "runId": 5, "startedAt": "2026-11-04T09:00:00Z", "products": ["backend"]}
        wrong_type = FakeAws(dump(SEED))
        wrong_type.call = None
        cases = {
            "the record is missing (ParameterNotFound)": (FakeAws(), "ParameterNotFound"),
            "access is denied": (self.failing(254, "An error occurred (AccessDeniedException)"), "was denied"),
            "the read keeps failing": (self.failing(255, "ThrottlingException"), "failed 3 time(s)"),
            "the record is malformed": (FakeAws("{not json"), "not JSON"),
            "the schema is unknown": (FakeAws(dump({**SEED, "schema": "x"})), "schema"),
            "a product is dirty": (FakeAws(dump(dirty)), "erp is dirty: run 5 may have changed lab-03"),
            "a run is inflight": (FakeAws(dump(inflight)), "deploy-lab.yml run 5 marked backend inflight"),
        }
        for label, (aws, text) in cases.items():
            code, out, err, gates, directory = self.read(aws)
            self.assertEqual((code, out), (1, ""), label)
            self.assertRegex(gates, r"^G9 FAIL: record: ", label)
            self.assertEqual(len(gates.splitlines()), 1, label)
            self.assertIn(text, gates, label)
            self.assertFalse((directory / "state" / "record.json").exists(), label)

    def failing(self, code, message):
        aws = FakeAws(dump(SEED))
        aws.get_errors = [(code, message)] * 10
        return aws

    def test_a_bad_given_path_is_a_usage_error(self):
        code, _, err = main(["read", "--given", "../../etc/passwd"], FakeAws(dump(SEED)))
        self.assertEqual(code, 2)


# ---------------------------------------------------------------- begin: the write-ahead marker

class Begin(Case):
    def begin(self, aws, kind="system", steps="backup,backend,console", expect=True, product=None):
        text = aws.value
        argv = ["begin", "--kind", kind, "--run-id", str(RUN), "--sha", MAIN_SHA]
        argv += ["--run-steps", steps] if kind == "system" else ["--product", product or kind]
        if expect and text is not None and kind == "system":
            argv += ["--expect-version", str(aws.version), "--expect-sha256", live_state.digest_of(text)]
        return main(argv, aws)

    def test_the_marker_is_written_before_anything_else(self):
        aws = FakeAws(dump(SEED))
        code, out, _ = self.begin(aws)
        self.assertEqual((code, out.strip()), (0, "begin_version=2"))
        record = self.stored(aws)
        self.assertEqual(record["inflight"]["products"], ["backend", "console"])
        self.assertEqual((record["inflight"]["runId"], record["writer"]["runId"]), (RUN, RUN))
        self.assertEqual(record["products"], json.loads(dump(SEED))["products"])  # nothing is claimed yet
        live_state.parse_record(aws.value)

    def test_the_state_changed_since_the_preflight_is_a_drift_refusal(self):
        aws = FakeAws(dump(SEED))
        argv = ["begin", "--kind", "system", "--run-id", str(RUN), "--sha", MAIN_SHA, "--run-steps", "erp",
                "--expect-version", "1", "--expect-sha256", live_state.digest_of(dump(SEED))]
        aws.value, aws.version = dump({**SEED, "note": "edited by hand"}), 2
        code, out, err = main(argv, aws)
        self.assertEqual((code, out, aws.puts()), (1, "", 0))
        self.assertIn("changed since the preflight read it", err)
        aws.value, aws.version = dump(SEED), 1
        aws.value = dump(SEED)  # same version, different digest: also a drift
        argv[argv.index("--expect-sha256") + 1] = "0" * 64
        self.assertEqual(main(argv, aws)[0], 1)

    def test_a_marker_that_cannot_be_written_stops_the_run_before_any_document(self):
        for mode in ("denied", "error"):
            aws = FakeAws(dump(SEED))
            aws.put_plan = [mode] * 5
            code, out, err = self.begin(aws)
            self.assertEqual((code, out), (1, ""), mode)
            self.assertEqual(aws.value, dump(SEED), mode)  # the record is exactly as it was

    def test_a_system_run_refuses_any_product_in_doubt(self):
        data = json.loads(dump(SEED))
        data["products"]["backend"].update(state="dirty", reason="run 5 may have changed lab-01")
        aws = FakeAws(dump(data))
        code, _, err = self.begin(aws, expect=False)
        self.assertEqual((code, aws.puts()), (1, 0))
        self.assertIn("only a successful deploy of exactly that product", err)

    def test_a_stale_marker_blocks_every_run_but_the_recovery_of_that_product(self):
        data = json.loads(dump(SEED))
        data["inflight"] = {"workflow": "deploy-lab.yml", "runId": 5, "startedAt": "2026-11-04T09:00:00Z", "products": ["backend"]}
        for kind, allowed in (("backend", True), ("console", False), ("erp", False)):
            aws = FakeAws(dump(data))
            code, _, err = self.begin(aws, kind=kind)
            self.assertEqual(code == 0, allowed, kind)
            if not allowed:
                self.assertEqual(aws.puts(), 0, kind)

    def test_a_dirty_product_only_a_run_of_itself_may_start(self):
        data = json.loads(dump(SEED))
        data["products"]["console"].update(state="dirty", reason="run 5 swapped the Console")
        aws = FakeAws(dump(data))
        self.assertEqual(self.begin(aws, kind="console")[0], 0)
        self.assertEqual(self.stored(aws)["products"]["console"]["state"], "dirty")  # still dirty until a ledger proves otherwise
        self.assertEqual(self.begin(FakeAws(dump(data)), kind="backend")[0], 1)

    def test_a_malformed_record_stops_begin(self):
        aws = FakeAws("{")
        self.assertEqual((self.begin(aws, expect=False)[0], aws.puts()), (1, 0))

    def test_usage_errors(self):
        for argv in (["begin", "--kind", "system", "--run-id", "1", "--sha", MAIN_SHA],
                     ["begin", "--kind", "system", "--run-id", "1", "--sha", MAIN_SHA, "--run-steps", "backend"],
                     ["begin", "--kind", "backend", "--run-id", "1", "--sha", MAIN_SHA],
                     ["begin", "--kind", "backend", "--run-id", "1", "--sha", MAIN_SHA, "--product", "erp"],
                     ["begin", "--kind", "system", "--run-id", "1", "--sha", "abc", "--run-steps", "erp"],
                     ["begin", "--kind", "system", "--run-id", "1", "--sha", MAIN_SHA, "--run-steps", "erp", "--expect-version", "1"]):
            aws = FakeAws(dump(SEED))
            code = main(argv, aws)[0]
            self.assertIn(code, (1, 2), argv)
            self.assertEqual(aws.puts(), 0, argv)


# ---------------------------------------------------------------- ambiguous writes

class Writes(Case):
    def put(self, aws, text):
        client = ssm(aws)
        version, before = client.get()
        return client.put_checked(text, version, before)

    def test_a_write_that_landed_despite_an_error_is_accepted_as_it_is(self):
        aws = FakeAws(dump(SEED))
        aws.put_plan = ["land-then-error"]
        self.assertEqual(self.put(aws, dump({**SEED, "note": "new"})), 2)
        self.assertEqual(aws.puts(), 1)  # never written twice

    def test_a_write_that_did_not_land_is_tried_again_a_bounded_number_of_times(self):
        aws = FakeAws(dump(SEED))
        aws.put_plan = ["error", "ok"]
        self.assertEqual(self.put(aws, dump({**SEED, "note": "new"})), 2)
        self.assertEqual(aws.puts(), 2)
        aws = FakeAws(dump(SEED))
        aws.put_plan = ["error"] * 5
        with self.assertRaises(live_state.StateError) as caught:
            self.put(aws, dump({**SEED, "note": "new"}))
        self.assertEqual(aws.puts(), 3)
        self.assertIn("could not be written in 3 attempts", str(caught.exception))

    def test_a_record_another_writer_changed_is_never_overwritten_again(self):
        aws = FakeAws(dump(SEED))
        aws.put_plan = ["error"]
        aws.on_get = lambda fake: (setattr(fake, "value", dump({**SEED, "note": "someone else"})), setattr(fake, "version", 2)) if fake.calls.count("put-parameter") == 1 else None
        with self.assertRaises(live_state.StateError) as caught:
            self.put(aws, dump({**SEED, "note": "new"}))
        self.assertIn("changed to another value", str(caught.exception))
        self.assertEqual(aws.puts(), 1)

    def test_a_failed_read_back_is_an_ambiguous_write(self):
        aws = FakeAws(dump(SEED))
        client = ssm(aws)
        version, before = client.get()
        aws.put_plan = ["land-then-error"]
        aws.get_errors = [(255, "network")] * 5
        with self.assertRaises(live_state.StateError) as caught:
            client.put_checked(dump({**SEED, "note": "new"}), version, before)
        self.assertIn("ambiguous", str(caught.exception))

    def test_a_write_that_replaced_another_writers_value_is_reported(self):
        aws = FakeAws(dump(SEED))
        client = ssm(aws)
        version, before = client.get()
        # the owner writes between this run's read and its write
        aws.value, aws.version = dump({**SEED, "note": "owner reconciliation"}), 2
        with self.assertRaises(live_state.StateError) as caught:
            client.put_checked(dump({**SEED, "note": "new"}), version, before)
        self.assertIn("another write landed between this run's read (version 1) and its write (version 3)", str(caught.exception))
        self.assertIn("version 2 in /rt/lab/live-state's history", str(caught.exception))

    def test_the_aws_cli_itself_never_retries_a_write(self):
        """A CLI retry of a write whose response was lost would write twice, and the version gap would read as another writer."""
        seen = []

        def fake_run(argv, **kwargs):
            seen.append((argv[-1] if argv[1:2] == ["ssm"] else argv, kwargs.get("env")))
            return mock.Mock(returncode=0, stdout="{}", stderr="")

        with mock.patch.object(live_state.subprocess, "run", fake_run):
            live_state.run_aws(["aws", "ssm", "put-parameter", "--name", live_state.PARAM, "--value", "{}"])
            live_state.run_aws(["aws", "ssm", "get-parameter", "--name", live_state.PARAM])
        (_, put_env), (_, get_env) = seen
        self.assertEqual(put_env["AWS_MAX_ATTEMPTS"], "1")
        self.assertIsNone(get_env)  # reads keep the CLI's own retries

    def test_a_denied_write_is_not_retried(self):
        aws = FakeAws(dump(SEED))
        aws.put_plan = ["denied", "ok"]
        with self.assertRaises(live_state.AwsError):
            self.put(aws, dump({**SEED, "note": "new"}))
        self.assertEqual(aws.puts(), 1)

    def test_an_oversized_record_is_not_written(self):
        aws = FakeAws(dump(SEED))
        with self.assertRaises(live_state.StateError):
            self.put(aws, "x" * 5000)
        self.assertEqual(aws.puts(), 0)

    def test_the_read_retries_transient_errors_but_not_a_missing_record(self):
        aws = FakeAws(dump(SEED))
        aws.get_errors = [(255, "ThrottlingException")] * 2
        self.assertEqual(ssm(aws).get()[0], 1)
        missing = FakeAws()
        with self.assertRaises(live_state.AwsError) as caught:
            ssm(missing).get()
        self.assertEqual((caught.exception.kind, missing.calls.count("get-parameter")), ("not-found", 1))


# ---------------------------------------------------------------- finish: only what a ledger proves

class FinishBase(Case):
    def start(self, kind="system", steps="backup,backend,console", record=None):
        aws = FakeAws(dump(record or before_upgrade()))
        argv = ["begin", "--kind", kind, "--run-id", str(RUN), "--sha", MAIN_SHA]
        argv += ["--run-steps", steps] if kind == "system" else ["--product", kind]
        self.assertEqual(main(argv, aws)[0], 0)
        return aws

    def finish(self, aws, ledger, kind="system", begin_version=None, manifest=True):
        directory = self.tmp()
        path = directory / "ledger.json"
        path.write_text(ledger if isinstance(ledger, str) else json.dumps(ledger), encoding="utf-8")
        argv = ["finish", "--kind", kind, "--run-id", str(RUN), "--sha", MAIN_SHA, "--ledger", str(path), "--out-dir", str(directory / "out"),
                "--begin-version", str(begin_version or aws.version)]
        if kind == "system" and manifest:
            argv += ["--manifest", str(ROOT / "system" / "releases" / "lab-2026.11.3.json")]
        with mock.patch.object(live_state, "tag_commit", lambda release, root=".": COMMITS[release]):
            code, out, err = main(argv, aws)
        evidence = directory / "out" / "state-finish.json"
        return code, out, err, (json.loads(evidence.read_text(encoding="utf-8")) if evidence.is_file() else None)

class Finish(FinishBase):
    def test_a_deployed_system_run_records_every_finished_step_and_names_the_system(self):
        aws = self.start()
        code, out, _, evidence = self.finish(aws, sys_ledger())
        self.assertEqual((code, out.strip()), (0, "finish_version=3"))
        record = self.stored(aws)
        self.assertEqual(record["inflight"], None)
        self.assertEqual(record["system"], "lab-2026.11.3")
        self.assertEqual(record["products"]["backend"], {"release": "backend-core/v0.5.0", "sha": B_SHA, "runId": RUN, "at": "2026-11-04T09:00:00Z", "state": "ok"})
        self.assertEqual(record["products"]["console"]["sha"], C_SHA)
        self.assertEqual(record["products"]["erp"], json.loads(dump(SEED))["products"]["erp"])  # skipped: untouched
        self.assertEqual((evidence["result"], evidence["before"]["version"], evidence["afterVersion"]), ("written", 2, 3))
        live_state.parse_record(aws.value)

    def test_a_console_failure_after_the_swap_leaves_it_dirty_and_never_ok(self):
        aws = self.start()
        ledger = sys_ledger(console="failed", console_lines=["RT_GATE G-Host pass", "RT_SWAP from=a to=b"], console_gates=("G-Host", "swap"),
                            failure={"reason": "live job stopped before or during RT-console"})
        self.assertEqual(self.finish(aws, ledger)[0], 0)
        record = self.stored(aws)
        self.assertEqual(record["products"]["backend"]["state"], "ok")
        self.assertEqual(record["products"]["backend"]["release"], "backend-core/v0.5.0")
        self.assertEqual(record["products"]["console"]["state"], "dirty")
        self.assertEqual(record["products"]["console"]["release"], "admin-console/v0.3.0")  # the old value stays, never the target
        self.assertIn("failed at its console step", record["products"]["console"]["reason"])
        self.assertEqual((record["inflight"], record["system"]), (None, None))
        # and the next system preflight refuses it
        read = main(["read", "--root", str(ROOT)], aws)
        self.assertEqual(read[0], 1)

    def test_a_cancelled_or_unknown_step_is_dirty_not_unchanged(self):
        aws = self.start()
        ledger = sys_ledger(console="failed", console_lines=[], console_status="InProgress",
                            failure={"reason": "live job stopped before or during RT-ConsoleLabDeploy"})
        self.finish(aws, ledger)
        self.assertEqual(self.stored(aws)["products"]["console"]["state"], "dirty")

    def test_a_failure_that_provably_never_sent_the_document_leaves_the_product_as_it_was(self):
        aws = self.start()
        ledger = sys_ledger(console="failed", console_lines=[], console_status=None, console_gates=(),
                            failure={"reason": "console: no parameters file, so RT-ConsoleLabDeploy was not sent"})
        code, _, _, _ = self.finish(aws, ledger)
        record = self.stored(aws)
        self.assertEqual((code, record["products"]["console"]["state"], record["products"]["console"]["release"]), (0, "ok", "admin-console/v0.3.0"))
        self.assertEqual(record["products"]["backend"]["release"], "backend-core/v0.5.0")
        self.assertEqual((record["inflight"], record["system"]), (None, None))

    def test_an_unreadable_ledger_makes_every_marked_product_dirty(self):
        for garbage in ("not json at all", json.dumps({"kind": "x"})):
            aws = self.start()
            code, _, _, _ = self.finish(aws, garbage)
            if code == 0:
                states = {name: item["state"] for name, item in self.stored(aws)["products"].items()}
                self.assertEqual((states["backend"], states["console"], states["erp"]), ("dirty", "dirty", "ok"), garbage)
            else:  # a ledger that is not JSON stops the step; the marker stays, which is the conservative result
                self.assertIsNotNone(self.stored(aws)["inflight"], garbage)

    def test_product_workflows_record_their_own_product(self):
        for kind, name in (("backend", "backend"), ("console", "console"), ("erp", "erp")):
            record = before_upgrade()
            if kind == "erp":
                record["products"]["erp"].update(digest="sha256:" + "a" * 64, sha="a" * 40)
            aws = self.start(kind=kind, record=record)
            code, out, _, _ = self.finish(aws, product_ledger(kind), kind=kind)
            self.assertEqual(code, 0, kind)
            item = self.stored(aws)["products"][name]
            self.assertEqual(item["state"], "ok", kind)
            self.assertEqual(item["runId"], RUN)
            self.assertEqual(self.stored(aws)["system"], None)  # a product run does not name a system
            self.assertEqual(self.stored(aws)["inflight"], None)
            if kind == "backend":
                self.assertEqual((item["release"], item["sha"]), ("backend-core/v0.5.0", B_SHA))
            if kind == "erp":
                self.assertEqual((item["digest"], item["sha"]), (DIGEST, E_SHA))

    def test_a_product_run_that_changed_the_host_but_did_not_finish_is_dirty(self):
        aws = self.start(kind="console")
        code, _, _, _ = self.finish(aws, product_ledger("console", outcome="failed", gates=("G-Host", "swap"), boundary={"gate": "console-smoke"}, swap=True), kind="console")
        item = self.stored(aws)["products"]["console"]
        self.assertEqual((code, item["state"], item["release"]), (0, "dirty", "admin-console/v0.3.0"))

    def test_a_product_run_stopped_at_a_safe_gate_changes_nothing(self):
        aws = self.start(kind="console")
        self.finish(aws, product_ledger("console", outcome="failed", gates=("G-Host", "fetch"), boundary={"gate": "check"}), kind="console")
        item = self.stored(aws)["products"]["console"]
        self.assertEqual((item["state"], item["release"], self.stored(aws)["inflight"]), ("ok", "admin-console/v0.3.0", None))

    def test_the_recovery_run_of_a_dirty_product_clears_it_and_only_it(self):
        record = before_upgrade()
        record["products"]["console"].update(state="dirty", reason="run 5 swapped the Console")
        aws = self.start(kind="console", record=record)
        self.assertEqual(self.finish(aws, product_ledger("console"), kind="console")[0], 0)
        stored = self.stored(aws)
        self.assertEqual((stored["products"]["console"]["state"], stored["products"]["console"]["release"]), ("ok", "admin-console/v0.4.0"))
        self.assertNotIn("reason", stored["products"]["console"])
        # a failed recovery that never reached the host leaves it dirty, never ok
        aws = self.start(kind="console", record=record)
        self.finish(aws, product_ledger("console", outcome="failed", gates=("G-Host",), boundary={"gate": "check"}), kind="console")
        self.assertEqual(self.stored(aws)["products"]["console"]["state"], "dirty")

    def test_a_record_someone_else_changed_is_left_alone(self):
        aws = self.start()
        marked = self.stored(aws)
        for edit in (lambda r: r.update(inflight=None), lambda r: r["inflight"].update(runId=OTHER_RUN),
                     lambda r: r["inflight"].update(workflow="deploy-lab.yml")):
            fresh = json.loads(json.dumps(marked))
            edit(fresh)
            other = FakeAws(dump(fresh), version=2)
            before = other.value
            code, out, err, _ = self.finish(other, sys_ledger(), begin_version=2)
            self.assertEqual((code, other.value, other.puts()), (1, before, 0))
        stale = FakeAws(aws.value, version=5)
        code, _, err, _ = self.finish(stale, sys_ledger(), begin_version=2)
        self.assertEqual((code, stale.puts()), (1, 0))
        self.assertIn("no longer the one this run marked", err)

    def test_a_failed_final_write_keeps_the_marker_and_the_intended_record_as_evidence(self):
        aws = self.start()
        aws.put_plan = ["error"] * 5
        code, out, err, evidence = self.finish(aws, sys_ledger())
        self.assertEqual((code, out), (1, ""))
        self.assertIsNotNone(self.stored(aws)["inflight"])  # still marked: the next preflight refuses
        self.assertTrue(evidence["result"].startswith("FAILED:"))
        self.assertEqual(evidence["intended"]["products"]["backend"]["release"], "backend-core/v0.5.0")
        self.assertEqual(evidence["intended"]["inflight"], None)

    def test_a_final_write_that_landed_despite_the_error_is_recorded_once(self):
        aws = self.start()
        aws.put_plan = ["land-then-error"]
        code, out, _, evidence = self.finish(aws, sys_ledger())
        self.assertEqual((code, evidence["result"], aws.puts()), (0, "written", 2))
        self.assertEqual(self.stored(aws)["inflight"], None)


class Recovery(FinishBase):
    """A marker an earlier run left behind is never silently cleared."""

    def stale(self, product="backend"):
        data = before_upgrade()
        data["inflight"] = {"workflow": "deploy-lab.yml", "runId": 5, "startedAt": "2026-11-04T08:00:00Z", "products": [product]}
        return data

    def test_begin_turns_a_stale_marker_into_dirty_before_it_writes_its_own(self):
        aws = FakeAws(dump(self.stale()))
        self.assertEqual(main(["begin", "--kind", "backend", "--run-id", str(RUN), "--sha", MAIN_SHA, "--product", "backend"], aws)[0], 0)
        record = self.stored(aws)
        self.assertEqual(record["inflight"]["runId"], RUN)
        self.assertEqual(record["products"]["backend"]["state"], "dirty")
        self.assertIn("run 5 marked it inflight at 2026-11-04T08:00:00Z and never recorded its end", record["products"]["backend"]["reason"])
        self.assertEqual(record["products"]["backend"]["release"], "backend-core/v0.4.0")  # the old value, not a claim

    def test_a_recovery_run_that_fails_before_the_host_leaves_the_stale_doubt_in_place(self):
        aws = FakeAws(dump(self.stale()))
        main(["begin", "--kind", "backend", "--run-id", str(RUN), "--sha", MAIN_SHA, "--product", "backend"], aws)
        code, _, _, _ = self.finish(aws, product_ledger("backend", outcome="failed", gates=("G-Host",), boundary={"gate": "G-Host"}), kind="backend")
        record = self.stored(aws)
        self.assertEqual((code, record["products"]["backend"]["state"], record["inflight"]), (0, "dirty", None))
        # and the system preflight still refuses it
        self.assertEqual(main(["read", "--root", str(ROOT)], aws)[0], 1)

    def test_a_recovery_run_that_a_ledger_proves_deployed_clears_it(self):
        aws = FakeAws(dump(self.stale()))
        main(["begin", "--kind", "backend", "--run-id", str(RUN), "--sha", MAIN_SHA, "--product", "backend"], aws)
        self.assertEqual(self.finish(aws, product_ledger("backend"), kind="backend")[0], 0)
        record = self.stored(aws)
        self.assertEqual((record["products"]["backend"]["state"], record["products"]["backend"]["release"], record["inflight"]), ("ok", "backend-core/v0.5.0", None))
        self.assertEqual(live_state.unresolved(live_state.parse_record(aws.value)), [])  # nothing left in doubt


class Commits(FinishBase):
    """The release commit comes from the ledger when it has it: a shallow checkout has no tags."""

    def no_tags(self, release, root="."):
        raise live_state.StateError(f"the tag {release} does not resolve to a commit here")

    def finish_without_tags(self, aws, ledger, kind):
        directory = self.tmp()
        path = directory / "ledger.json"
        path.write_text(json.dumps(ledger), encoding="utf-8")
        argv = ["finish", "--kind", kind, "--run-id", str(RUN), "--sha", MAIN_SHA, "--ledger", str(path), "--out-dir", str(directory / "out"),
                "--begin-version", str(aws.version)]
        with mock.patch.object(live_state, "tag_commit", self.no_tags):
            return main(argv, aws), directory

    def test_a_console_and_a_backend_product_run_record_without_any_tag(self):
        for kind in ("console", "backend"):
            aws = self.start(kind=kind)
            (code, out, err), _ = self.finish_without_tags(aws, product_ledger(kind), kind)
            self.assertEqual(code, 0, f"{kind}: {err}")
            self.assertEqual(self.stored(aws)["products"][kind]["sha"], {"console": C_SHA, "backend": B_SHA}[kind])

    def test_without_a_commit_in_the_ledger_and_without_the_tag_nothing_is_recorded_and_the_marker_stays(self):
        aws = self.start(kind="console")
        ledger = product_ledger("console")
        del ledger["target"]["sha"]
        (code, out, err), directory = self.finish_without_tags(aws, ledger, "console")
        self.assertEqual(code, 1)
        self.assertIsNotNone(self.stored(aws)["inflight"])
        evidence = json.loads((directory / "out" / "state-finish.json").read_text(encoding="utf-8"))
        self.assertTrue(evidence["result"].startswith("FAILED:"))
        self.assertNotIn("intended", evidence)  # it could not be computed

    def test_evidence_is_kept_on_every_finish_failure_after_the_pre_check(self):
        aws = self.start()
        directory = self.tmp()
        argv = ["finish", "--kind", "system", "--run-id", str(RUN), "--sha", MAIN_SHA, "--ledger", str(directory / "missing.json"),
                "--out-dir", str(directory / "out"), "--begin-version", str(aws.version)]
        self.assertEqual(main(argv, aws)[0], 1)
        evidence = json.loads((directory / "out" / "state-finish.json").read_text(encoding="utf-8"))
        self.assertTrue(evidence["result"].startswith("FAILED:"))
        self.assertIsNotNone(self.stored(aws)["inflight"])

    def test_the_commit_of_a_tag_comes_from_git(self):
        import subprocess
        repo = self.tmp()
        git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"]
        subprocess.run([*git, "init", "-q"], check=True, capture_output=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "x"], check=True, capture_output=True)
        subprocess.run([*git, "tag", "backend-core/v0.5.0"], check=True, capture_output=True)
        head = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(live_state.tag_commit("backend-core/v0.5.0", repo), head)
        with self.assertRaises(live_state.StateError):
            live_state.tag_commit("backend-core/v99.0.0", repo)


class Usage(Case):

    def test_the_cli_takes_no_parameter_name(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                live_state.main(["--param", "/other", "read"], ssm=ssm(FakeAws(dump(SEED))))


if __name__ == "__main__":
    unittest.main()
