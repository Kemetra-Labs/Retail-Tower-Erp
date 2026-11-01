"""G8 (live lab check) of deploy-system-lab.yml: tests of live_check.py against fake GitHub data.

The ledger shapes are those the real live runs uploaded on 2026-11-01 (deploy-lab 41292062348,
deploy-console-lab 41295078323, deploy-erp-lab 40916489627, deploy-system-lab 41306750385), so the
decider is checked without the GitHub API.
"""
import io
import json
import pathlib
import re
import tempfile
import unittest
import zipfile

import live_check
import system_ledger

ROOT = pathlib.Path(__file__).resolve().parents[2]
OLD = ROOT / "system" / "releases" / "lab-2026.11.0.json"  # backend v0.3.2, console v0.1.0
LIVE = ROOT / "system" / "releases" / "lab-2026.11.1.json"  # backend v0.3.3, console v0.2.0
DIGEST = "sha256:936f67e636021aa88e9fb15ff91134a2f73573b153f59c7d1017293313585415"
SHA = "9b9c1780b08b5a3a09fda7394d5dd10a6aab33c1"
OTHER_DIGEST = "sha256:" + "d" * 64
OTHER_SHA = "e" * 40
GOOD_BACKEND_GATES = ["G-Host", "G-Backup", "fetch", "backup-config", "arm-revert", "migrate", "start"]


def pack(ledger):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("ledger.json", json.dumps(ledger))
    return out.getvalue()


def gates(*names):
    return [{"gate": name, "result": "pass"} for name in names]


def at(minute):
    return f"2026-11-01T{minute // 60:02d}:{minute % 60:02d}:00Z"


class Fake:
    """The four calls live_check makes, over in-memory runs."""

    def __init__(self):
        self.listing, self.by_run, self.blobs, self.job_list, self.counter = {}, {}, {}, {}, 0

    def add(self, workflow, run_id, minute, ledger=None, conclusion="success", branch="main", expired=False, jobs=None, name=None):
        run = {"id": run_id, "created_at": at(minute), "status": "completed", "conclusion": conclusion, "head_branch": branch}
        self.listing.setdefault(workflow, []).append(run)
        if ledger is not None:
            self.counter += 1
            prefix = {v[0]: v[1] for v in live_check.SPECS.values()}[workflow]
            self.by_run[run_id] = [{"id": self.counter, "name": name or f"{prefix}-{run_id}", "expired": expired, "size_in_bytes": 100}]
            self.blobs[self.counter] = pack(ledger) if isinstance(ledger, dict) else ledger
        if jobs is not None:
            self.job_list[run_id] = jobs

    def runs(self, workflow, limit):
        runs = self.listing.get(workflow, [])
        return {"total_count": len(runs), "workflow_runs": runs[:limit]}

    def artifacts(self, run_id):
        return self.by_run.get(run_id, [])

    def jobs(self, run_id):
        return self.job_list.get(run_id, [])

    def download(self, artifact_id):
        return self.blobs[artifact_id]


def backend(run_id, tag="backend-core/v0.3.3", outcome="deployed", names=GOOD_BACKEND_GATES, revert=(), boundary=None):
    return {"kind": "rt842-lab-live-ledger", "mode": "live", "outcome": outcome, "release": {"tag": tag, "sha": "f" * 40},
            "gates": gates(*names), "revert": list(revert), "failureBoundary": boundary,
            "runUrl": f"https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/{run_id}"}


def console(run_id, release="admin-console/v0.2.0", outcome="deployed", names=("G-Host", "fetch", "check", "swap", "console-smoke"),
            swap="RT_SWAP from=admin-console-v0.1.0 to=admin-console-v0.2.0", boundary=None, revert=()):
    return {"kind": "rt1007-console-lab-live-ledger", "mode": "live", "outcome": outcome, "target": {"release": release},
            "gates": gates(*names), "swap": swap, "revert": list(revert), "failureBoundary": boundary,
            "runUrl": f"https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/{run_id}"}


def erp(run_id, digest=DIGEST, sha=SHA, outcome="deployed", names=("check", "stop", "swap", "migrate", "resume"), boundary=None):
    return {"kind": "rt927-erp-lab-live-ledger", "mode": "live", "outcome": outcome, "target": {"digest": digest, "sha": sha},
            "gates": gates(*names), "failureBoundary": boundary,
            "runUrl": f"https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/{run_id}"}


def system(run_id, name="lab-2026.11.1", outcome="deployed", steps=None):
    ok = {"state": "ok", "lines": [], "gates": [], "ssmStatus": "Success"}
    default = [
        {"step": "backup", **ok, "target": {}},
        {"step": "backend", **ok, "target": {"release": "backend-core/v0.3.3"}},
        {"step": "console", **ok, "target": {"release": "admin-console/v0.2.0"}},
        {"step": "erp", **ok, "target": {"sha": SHA, "image": "ghcr.io/kemetra-labs/rt-erpnext@" + DIGEST}},
    ]
    return {"kind": system_ledger.LIVE_KIND, "mode": "live", "outcome": outcome, "system": name, "steps": steps or default,
            "runUrl": f"https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/{run_id}"}


def live_lab():
    """The lab after 2026-11-01: every product at lab-2026.11.1, plus dry runs in between."""
    fake = Fake()
    fake.add("deploy-lab.yml", 41292062348, 551, backend(41292062348))
    fake.add("deploy-lab.yml", 41291973149, 550)  # a dry run: no live ledger
    fake.add("deploy-console-lab.yml", 41295078323, 593, console(41295078323))
    fake.add("deploy-erp-lab.yml", 40916489627, 1000 - 1000 + 5, erp(40916489627))
    fake.add("deploy-system-lab.yml", 41306750385, 757, system(41306750385))
    return fake


def run_check(fake, manifest=LIVE):
    return live_check.check(fake, manifest)


def failures(lines):
    return [text for ok, text in lines if not ok]


class Decide(unittest.TestCase):
    def test_the_live_manifest_passes(self):
        lines = run_check(live_lab())
        self.assertEqual(failures(lines), [])
        self.assertEqual(len(lines), 3)

    def test_a_stale_manifest_is_refused_naming_each_product(self):
        found = failures(run_check(live_lab(), OLD))
        self.assertEqual(len(found), 2, found)
        self.assertTrue(any("backend" in text and "v0.3.3" in text and "v0.3.2" in text for text in found))
        self.assertTrue(any("console" in text and "v0.2.0" in text and "v0.1.0" in text for text in found))

    def test_a_different_erp_image_or_commit_is_refused(self):
        for digest, sha in ((OTHER_DIGEST, SHA), (DIGEST, OTHER_SHA)):
            fake = Fake()
            fake.add("deploy-lab.yml", 1, 10, backend(1))
            fake.add("deploy-console-lab.yml", 2, 11, console(2))
            fake.add("deploy-erp-lab.yml", 3, 12, erp(3, digest=digest, sha=sha))
            found = failures(run_check(fake))
            self.assertEqual(len(found), 1, found)
            self.assertIn("erp", found[0])

    def test_dry_runs_are_skipped_and_the_first_deployed_run_ends_the_scan(self):
        fake = live_lab()
        fake.add("deploy-lab.yml", 41000000000, 1, backend(41000000000, tag="backend-core/v0.2.0"))  # older: never read
        fake.blobs[fake.counter] = b"not a zip"  # even a broken older ledger is not read
        self.assertEqual(failures(run_check(fake)), [])

    def test_a_newer_system_deploy_of_another_manifest_is_refused(self):
        fake = live_lab()
        newer = system(41400000000, name="lab-2026.11.2")
        newer["steps"][1]["target"] = {"release": "backend-core/v0.3.4"}
        fake.add("deploy-system-lab.yml", 41400000000, 900, newer)
        found = failures(run_check(fake))
        self.assertEqual(len(found), 1, found)
        self.assertIn("backend-core/v0.3.4", found[0])
        self.assertIn("lab-2026.11.2", found[0])
        self.assertEqual(failures(run_check(fake, ROOT / "system" / "releases" / "lab-2026.11.1.json"))[0], found[0])

    def test_a_system_deploy_older_than_a_product_deploy_does_not_win(self):
        fake = live_lab()
        fake.add("deploy-console-lab.yml", 41296000000, 800, console(41296000000, release="admin-console/v0.3.0"))
        found = failures(run_check(fake))
        self.assertEqual(len(found), 1, found)
        self.assertIn("admin-console/v0.3.0", found[0])

    def test_a_system_run_that_failed_part_way_counts_only_its_finished_steps(self):
        fake = Fake()
        fake.add("deploy-erp-lab.yml", 3, 5, erp(3))
        fake.add("deploy-lab.yml", 1, 5, backend(1, tag="backend-core/v0.3.2"))
        fake.add("deploy-console-lab.yml", 2, 5, console(2, release="admin-console/v0.1.0"))
        partial = system(4, name="lab-2026.11.1", outcome="failed-at:console")
        partial["steps"][2] = {"step": "console", "state": "failed", "ssmStatus": "Failed", "target": {"release": "admin-console/v0.2.0"},
                               "lines": ["RT_GATE G-Host pass", "RT_GATE fetch pass", "RT_SWAP from=a to=b"], "gates": gates("G-Host", "fetch")}
        partial["steps"][3] = {"step": "erp", "state": "not-run", "lines": [], "gates": [], "ssmStatus": None}
        fake.add("deploy-system-lab.yml", 4, 100, partial)
        found = failures(run_check(fake))
        # backend v0.3.3 (finished step of the system run) matches the manifest; the console swap may have happened
        self.assertEqual(len(found), 2, found)
        self.assertTrue(all(text.startswith("console") for text in found), found)
        self.assertTrue(any("v0.1.0" in text and "v0.2.0" in text for text in found))
        self.assertTrue(any("may have changed the host" in text for text in found))
        self.assertEqual(failures(run_check(fake, OLD))[0].split(":")[0], "backend")

    def test_a_system_run_that_failed_before_a_host_is_only_a_note(self):
        fake = live_lab()
        refused = system(41500000000, outcome="failed-at:backend")
        refused["steps"][1] = {"step": "backend", "state": "failed", "ssmStatus": "Failed", "target": {}, "gates": gates("G-Host"),
                               "lines": ["RT_FAIL gate=G-Host reason=wrapper-does-not-use-the-current-release"]}
        refused["steps"][2] = {"step": "console", "state": "not-run", "lines": [], "gates": [], "ssmStatus": None}
        refused["steps"][3] = {"step": "erp", "state": "not-run", "lines": [], "gates": [], "ssmStatus": None}
        fake.add("deploy-system-lab.yml", 41500000000, 950, refused)
        lines = run_check(fake)
        self.assertEqual(failures(lines), [])
        self.assertTrue(any("note" in text and "backend" in text for _, text in lines))

    def test_a_system_run_that_never_sent_its_document_is_only_a_note(self):
        fake = live_lab()
        never = system(41500000001, outcome="failed-at:backup")
        never["steps"][0] = {"step": "backup", "state": "failed", "lines": [], "gates": [], "ssmStatus": None, "target": {}}
        for index, step in enumerate(("backend", "console", "erp"), 1):
            never["steps"][index] = {"step": step, "state": "not-run", "lines": [], "gates": [], "ssmStatus": None, "target": {}}
        fake.add("deploy-system-lab.yml", 41500000001, 951, never)
        self.assertEqual(failures(run_check(fake)), [])

    def failed_system_step(self, name, step, reason=None, outcome="failed"):
        fake = live_lab()
        run = system(41510000000, outcome=outcome)
        run["failure"] = {"step": name, "reason": reason} if reason else None
        index = {"backend": 1, "console": 2, "erp": 3}[name]
        run["steps"][index] = {"step": name, "state": "failed", "target": {}, **step}
        for later in range(index + 1, 4):
            run["steps"][later] = {"step": run["steps"][later]["step"], "state": "not-run", "lines": [], "gates": [], "ssmStatus": None, "target": {}}
        fake.add("deploy-system-lab.yml", 41510000000, 952, run)
        return run_check(fake)

    def test_a_system_step_cancelled_mid_poll_may_have_changed_the_host(self):
        # ssm-run.sh writes .status and .lines only after the poll, so a cancel leaves both empty
        for reason in ("live job stopped before or during RT-BackendLabDeploy", None, "backend: the document ended TimedOut"):
            lines = self.failed_system_step("backend", {"lines": [], "gates": [], "ssmStatus": None}, reason)
            found = failures(lines)
            self.assertEqual(len(found), 1, (reason, found))
            self.assertIn("may have changed the host", found[0])

    def test_a_system_step_that_stopped_before_the_document_was_sent_is_a_note(self):
        for reason in ("backend: send-command was refused", "backend: no single Online SSM node tagged Environment=lab, Host=lab-01",
                       "backend: no parameters file"):
            lines = self.failed_system_step("backend", {"lines": [], "gates": [], "ssmStatus": None}, reason)
            self.assertEqual(failures(lines), [], reason)
            self.assertTrue(any("note" in text for _, text in lines), reason)
        # a pre-send reason names its own step: the backend's reason does not clear a console step
        self.assertEqual(len(failures(self.failed_system_step("console", {"lines": [], "gates": [], "ssmStatus": None}, "backend: send-command was refused"))), 1)

    def test_an_erp_stop_in_a_system_run_before_its_stop_gate_is_a_note_and_after_it_is_not(self):
        for gate_lines in (["RT_GATE inputs=fail", "RT_OUTCOME=failed"], ["RT_GATE lock=fail", "RT_OUTCOME=failed"],
                           ["RT_GATE check=pass", "RT_GATE check=fail", "RT_OUTCOME=failed"]):
            step = {"lines": gate_lines, "gates": [{"gate": line.split(" ")[1].split("=")[0], "result": line.split("=")[1]} for line in gate_lines if line.startswith("RT_GATE")],
                    "ssmStatus": "Failed"}
            self.assertEqual(failures(self.failed_system_step("erp", step, "erp: the document ended Failed")), [], gate_lines)
        for gate_lines in (["RT_GATE check=pass", "RT_GATE stop=pass", "RT_GATE backup=fail", "RT_OUTCOME=failed"],
                           ["RT_GATE check=pass", "RT_GATE stop=pass", "RT_GATE swap=pass", "RT_OUTCOME=held"]):
            step = {"lines": gate_lines, "gates": [{"gate": line.split(" ")[1].split("=")[0], "result": line.split("=")[1]} for line in gate_lines if line.startswith("RT_GATE")],
                    "ssmStatus": "Failed"}
            self.assertEqual(len(failures(self.failed_system_step("erp", step, "erp: the document ended Failed"))), 1, gate_lines)

    def test_a_product_with_no_deployed_ledger_is_unknown_and_refused(self):
        fake = live_lab()
        fake.listing["deploy-erp-lab.yml"] = []
        fake.listing["deploy-system-lab.yml"] = []
        found = failures(run_check(fake))
        self.assertEqual(len(found), 1, found)
        self.assertIn("erp", found[0])
        self.assertIn("unknown", found[0])


class Incidents(unittest.TestCase):
    def test_backend_failed_after_migrate_refuses_until_a_newer_deploy(self):
        fake = live_lab()
        failed = backend(41600000000, tag="backend-core/v0.3.4", outcome="failed", names=("G-Host", "G-Backup", "fetch", "backup-config", "arm-revert", "migrate"),
                         revert=["RT_REVERT armed unit=x"], boundary={"gate": "G-Ready", "reason": "health"})
        fake.add("deploy-lab.yml", 41600000000, 960, failed, conclusion="failure")
        found = failures(run_check(fake))
        self.assertEqual(len(found), 1, found)
        self.assertIn("backend", found[0])
        self.assertIn("may have changed the host", found[0])
        self.assertIn("deploy-lab.yml run 41600000000", found[0])
        fake.add("deploy-lab.yml", 41600000001, 970, backend(41600000001))
        self.assertEqual(failures(run_check(fake)), [])

    def test_backend_refused_at_g_host_is_a_note(self):
        fake = live_lab()
        refused = backend(41600000002, outcome="failed", names=("backup-preconditions", "backup-dump", "backup-restore-rehearsal"),
                          boundary={"gate": "G-Host", "reason": "wrapper-does-not-use-the-current-release"})
        fake.add("deploy-lab.yml", 41600000002, 960, refused, conclusion="failure")
        lines = run_check(fake)
        self.assertEqual(failures(lines), [])
        self.assertTrue(any("note" in text for _, text in lines))

    def test_console_whose_live_job_never_reached_ssm_is_a_note(self):
        fake = live_lab()
        skipped = console(41600000003, outcome="failed", names=(), swap=None,
                          boundary={"reason": "live job stopped before or during the SSM run (outcome: skipped)"})
        fake.add("deploy-console-lab.yml", 41600000003, 960, skipped, conclusion="failure")
        self.assertEqual(failures(run_check(fake)), [])

    def test_console_that_swapped_or_was_cancelled_mid_run_refuses(self):
        for ledger in (console(41600000004, outcome="failed", names=("G-Host", "fetch", "check"), swap="RT_SWAP from=a to=b", boundary={"gate": "console-smoke"}),
                       console(41600000004, outcome="failed", names=(), swap=None, boundary={"reason": "live job stopped before or during the SSM run (outcome: cancelled)"}),
                       console(41600000004, outcome="failed", names=("G-Host",), swap=None, revert=["RT_REVERT failed current=x"], boundary={"gate": "swap"})):
            fake = live_lab()
            fake.add("deploy-console-lab.yml", 41600000004, 960, ledger, conclusion="failure")
            self.assertEqual(len(failures(run_check(fake))), 1, ledger["failureBoundary"])

    def test_erp_held_refuses_and_erp_refused_at_inputs_is_a_note(self):
        fake = live_lab()
        fake.add("deploy-erp-lab.yml", 41600000005, 960, erp(41600000005, outcome="held", names=("check", "stop", "backup", "swap", "migrate")), conclusion="success")
        found = failures(run_check(fake))
        self.assertEqual(len(found), 1, found)
        self.assertIn("erp", found[0])
        fake = live_lab()
        fake.add("deploy-erp-lab.yml", 41600000006, 960,
                 erp(41600000006, outcome="failed", names=("inputs",), boundary="RT_GATE inputs=fail"), conclusion="failure")
        self.assertEqual(failures(run_check(fake)), [])

    def test_erp_failed_after_its_stop_gate_refuses(self):
        fake = live_lab()
        fake.add("deploy-erp-lab.yml", 41600000007, 960,
                 erp(41600000007, outcome="failed", names=("check", "stop", "backup"), boundary="RT_GATE swap=fail"), conclusion="failure")
        self.assertEqual(len(failures(run_check(fake))), 1)

    def test_a_failed_run_with_a_started_live_job_and_no_ledger_refuses(self):
        fake = live_lab()
        fake.add("deploy-lab.yml", 41600000008, 960, None, conclusion="failure",
                 jobs=[{"name": "preflight (x)", "started_at": at(960), "conclusion": "success"},
                       {"name": "live deploy (aws-lab)", "started_at": at(961), "conclusion": "failure"}])
        found = failures(run_check(fake))
        self.assertEqual(len(found), 3, found)  # an unknown outcome concerns every product

    def test_failed_or_cancelled_runs_that_never_started_the_live_job_are_ignored(self):
        fake = live_lab()
        fake.add("deploy-lab.yml", 41600000009, 960, None, conclusion="failure",
                 jobs=[{"name": "preflight (x)", "started_at": at(960), "conclusion": "failure"},
                       {"name": "live deploy (aws-lab)", "started_at": None, "conclusion": "skipped"}])
        fake.add("deploy-lab.yml", 41600000010, 961, None, conclusion="cancelled", jobs=[])
        self.assertEqual(failures(run_check(fake)), [])


class FailClosed(unittest.TestCase):
    def assertRefused(self, fake, text):
        with self.assertRaises(live_check.LiveError) as caught:
            run_check(fake)
        self.assertIn(text, str(caught.exception))

    def test_an_expired_ledger_refuses(self):
        fake = Fake()
        fake.add("deploy-lab.yml", 1, 1, backend(1), expired=True)
        self.assertRefused(fake, "expired")

    def test_a_broken_ledger_refuses(self):
        fake = Fake()
        fake.add("deploy-lab.yml", 1, 1, b"not a zip")
        self.assertRefused(fake, "unreadable")

    def test_a_rerun_refuses_because_its_ledger_cannot_be_ordered(self):
        fake = live_lab()
        fake.listing["deploy-lab.yml"][0]["run_attempt"] = 2
        self.assertRefused(fake, "is a re-run")
        fake = live_lab()
        fake.add("deploy-lab.yml", 41800000000, 990, None, conclusion="failure", jobs=[{"name": "live deploy", "started_at": at(990), "conclusion": "failure"}])
        fake.listing["deploy-lab.yml"][-1]["run_attempt"] = 3
        self.assertRefused(fake, "is a re-run")

    def test_a_ledger_of_another_run_or_kind_refuses(self):
        fake = Fake()
        fake.add("deploy-lab.yml", 1, 1, backend(999))
        self.assertRefused(fake, "does not name its own run")
        fake = Fake()
        other = backend(1)
        other["kind"] = "rt927-erp-lab-live-ledger"
        fake.add("deploy-lab.yml", 1, 1, other)
        self.assertRefused(fake, "not a rt842-lab-live-ledger")
        fake = Fake()
        dry = backend(1)
        dry["mode"] = "dry-run"
        fake.add("deploy-lab.yml", 1, 1, dry)
        self.assertRefused(fake, "not a rt842-lab-live-ledger")

    def test_a_malformed_version_refuses(self):
        fake = Fake()
        fake.add("deploy-lab.yml", 1, 1, backend(1, tag="backend-core/v0.3.3; id"))
        self.assertRefused(fake, "malformed")
        fake = Fake()
        fake.add("deploy-erp-lab.yml", 1, 1, erp(1, digest="sha256:short"))
        self.assertRefused(fake, "malformed")

    def test_a_truncated_run_list_without_a_deployed_run_refuses(self):
        fake = Fake()
        fake.add("deploy-lab.yml", 1, 1, backend(1, outcome="failed", boundary={"gate": "G-Host"}, names=()), conclusion="failure")
        fake.runs = lambda workflow, limit: {"total_count": 250, "workflow_runs": Fake.runs(fake, workflow, limit)["workflow_runs"]}
        self.assertRefused(fake, "no deployed live ledger in the newest")

    def test_runs_from_other_branches_cannot_forge_the_live_state(self):
        fake = live_lab()
        fake.add("deploy-lab.yml", 41700000000, 990, backend(41700000000, tag="backend-core/v9.9.9"), branch="feature/x")
        self.assertEqual(failures(run_check(fake)), [])

    def test_a_token_or_api_error_is_a_g8_failure_not_a_traceback(self):
        class Broken(Fake):
            def runs(self, workflow, limit):
                raise live_check.LiveError("GitHub refused actions/workflows: HTTP 403")

        with tempfile.TemporaryDirectory() as tmp:
            gates_file = pathlib.Path(tmp) / "gates.txt"
            code = live_check.main(["--repo", "o/r", "--current-manifest", str(LIVE), "--gates-file", str(gates_file)], api=Broken())
            self.assertEqual(code, 1)
            self.assertIn("G8 FAIL: the live lab could not be read", gates_file.read_text(encoding="utf-8"))

    def test_an_unknown_system_step_state_refuses(self):
        for state in ("running", None):
            fake = live_lab()
            steps = [{"step": "backend", "state": state, "lines": [], "gates": [], "ssmStatus": None, "target": {}}]
            fake.add("deploy-system-lab.yml", 41306750999, 800, system(41306750999, steps=steps))
            self.assertRefused(fake, "the backend step has an unknown state")

    def test_a_malformed_system_ledger_is_a_g8_failure_not_a_traceback(self):
        for steps in (["backend"], [{"step": "backend", "state": "ok", "target": ["x"]}]):
            fake = live_lab()
            fake.add("deploy-system-lab.yml", 41306750999, 800, system(41306750999, steps=steps))
            with tempfile.TemporaryDirectory() as tmp:
                gates_file = pathlib.Path(tmp) / "gates.txt"
                code = live_check.main(["--repo", "o/r", "--current-manifest", str(LIVE), "--gates-file", str(gates_file)], api=fake)
                self.assertEqual(code, 1)
                self.assertIn("G8 FAIL: the live lab could not be read", gates_file.read_text(encoding="utf-8"))

    def test_the_repository_name_is_checked(self):
        for bad in ("", "owner", "a/b; id", "../x"):
            with self.assertRaises(live_check.LiveError, msg=bad):
                live_check.GhApi(bad)


SSM = ROOT / "services" / "backend-core" / "deploy" / "lab" / "ssm"
ERP_DOCUMENT = ROOT / "integrations" / "erpnext-connector" / "deploy" / "lab" / "ssm" / "RT-ErpLabDeploy.json"


def document_gates(path):
    """The GATE=<name> names of an SSM document in the order the document runs them, once each."""
    names = re.findall(r"(?<![$\w])GATE=([A-Za-z0-9_.-]+)", path.read_text(encoding="utf-8"))
    return list(dict.fromkeys(names))


class SafeGatesFollowTheDocuments(unittest.TestCase):
    """SAFE_GATES must be exactly the gates a document runs before its first change to the host."""

    def check(self, product, document, first_change):
        names = document_gates(document)
        self.assertIn(first_change, names)
        before, after = names[: names.index(first_change)], names[names.index(first_change):]
        self.assertTrue(set(before) <= live_check.SAFE_GATES[product], (product, set(before) - live_check.SAFE_GATES[product]))
        self.assertFalse(set(after) & live_check.SAFE_GATES[product], (product, set(after) & live_check.SAFE_GATES[product]))

    def test_backend_deploy_document(self):
        self.check("backend", SSM / "RT-BackendLabDeploy.yaml", "arm-revert")

    def test_backend_backup_document_only_writes_a_dump(self):
        names = document_gates(SSM / "RT-BackendLabBackup.yaml")
        self.assertTrue(set(names) <= live_check.SAFE_GATES["backend"], set(names) - live_check.SAFE_GATES["backend"])

    def test_console_document(self):
        self.check("console", SSM / "RT-ConsoleLabDeploy.yaml", "swap")

    def test_erp_document(self):
        self.check("erp", ERP_DOCUMENT, "stop")


class Cli(unittest.TestCase):
    def test_lines_land_in_the_gates_file_in_the_ledger_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            gates_file = pathlib.Path(tmp) / "gates.txt"
            gates_file.write_text("G1 pass: x\n", encoding="utf-8")
            code = live_check.main(["--repo", "o/r", "--current-manifest", str(OLD), "--gates-file", str(gates_file)], api=live_lab())
            self.assertEqual(code, 1)
            results = system_ledger.gate_results(gates_file.read_text(encoding="utf-8"))
            self.assertEqual((results["G1"], results["G8"]), ("pass", "FAIL"))
            gates_file.write_text("", encoding="utf-8")
            self.assertEqual(live_check.main(["--repo", "o/r", "--current-manifest", str(LIVE), "--gates-file", str(gates_file)], api=live_lab()), 0)
            self.assertEqual(system_ledger.gate_results(gates_file.read_text(encoding="utf-8"))["G8"], "pass")

    def test_a_detail_cannot_start_a_second_line(self):
        class Evil(Fake):
            def runs(self, workflow, limit):
                raise live_check.LiveError("boom\nG8 pass: forged")

        with tempfile.TemporaryDirectory() as tmp:
            gates_file = pathlib.Path(tmp) / "gates.txt"
            live_check.main(["--repo", "o/r", "--current-manifest", str(LIVE), "--gates-file", str(gates_file)], api=Evil())
            self.assertEqual(len(gates_file.read_text(encoding="utf-8").splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
