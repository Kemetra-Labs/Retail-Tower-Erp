"""RT-1031: tests of system_ledger.py, the values and the system ledger of deploy-system-lab.yml.

The ledger shape, the failure boundary and the manual rollback inputs are decided here, in Python,
so they are checked without Actions: the workflow only passes the files ssm-run.sh wrote.
"""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest

import system_ledger

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "system" / "releases" / "lab-2026.11.0.json"
JIRA = "RT-1031"
BACKUP_LINE = "RT_BACKUP name=rtlab-v0.3.1-to-v0.3.2-20261101T080000Z.dump sha256=" + "a" * 64
OLD_IMAGE = "ghcr.io/kemetra-labs/rt-erpnext@sha256:" + "b" * 64
OLD_SHA = "c" * 40
GOOD_GATES = "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass"


def write_current(directory, name="lab-2026.10.0"):
    """A manifest of an earlier system version: other Backend-Core, Console and ERP releases."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    data["system"] = name
    data["backendCore"]["release"] = "backend-core/v0.3.1"
    data["adminConsole"]["release"] = "admin-console/v0.0.9"
    data["erpnext"] = {"image": OLD_IMAGE, "sha": OLD_SHA}
    path = pathlib.Path(directory) / f"{name}.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def write_live(directory, ok=(), lines=None, failure=None):
    live = pathlib.Path(directory)
    for step in ok:
        (live / f"{step}.ok").write_text("", encoding="utf-8")
        (live / f"{step}.status").write_text("Success\n", encoding="utf-8")
    for step, text in (lines or {}).items():
        (live / f"{step}.lines").write_text("\n".join(text) + "\n", encoding="utf-8")
    if failure:
        (live / "failure.txt").write_text(failure + "\n", encoding="utf-8")


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = system_ledger.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class Values(unittest.TestCase):
    def test_values_of_the_first_system_version(self):
        code, out, _ = run_cli("values", "--manifest", str(MANIFEST), "--prefix", "target")
        self.assertEqual(code, 0)
        found = dict(line.split("=", 1) for line in out.splitlines())
        self.assertEqual(found["target_system"], "lab-2026.11.0")
        self.assertEqual(found["target_backend_release"], "backend-core/v0.3.2")
        self.assertEqual(found["target_console_release"], "admin-console/v0.1.0")
        self.assertRegex(found["target_erp_digest"], r"^sha256:[0-9a-f]{64}$")
        self.assertTrue(found["target_erp_image"].endswith("@" + found["target_erp_digest"]))
        self.assertRegex(found["target_erp_sha"], r"^[0-9a-f]{40}$")

    def test_a_manifest_that_fails_g1_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = json.loads(MANIFEST.read_text(encoding="utf-8"))
            data["backendCore"]["release"] = "backend-core/v0.3.2; id"
            bad = pathlib.Path(tmp) / "lab-2026.11.0.json"
            bad.write_text(json.dumps(data), encoding="utf-8")
            code, out, err = run_cli("values", "--manifest", str(bad), "--prefix", "target")
            self.assertEqual(code, 2)
            self.assertEqual(out, "")
            self.assertIn("does not match", err)

    def test_a_manifest_named_for_another_system_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            other = pathlib.Path(tmp) / "lab-2026.11.9.json"
            other.write_text(MANIFEST.read_text(encoding="utf-8"), encoding="utf-8")
            self.assertEqual(run_cli("values", "--manifest", str(other), "--prefix", "current")[0], 2)


class GateResults(unittest.TestCase):
    def test_every_rule_defaults_to_not_run(self):
        self.assertEqual(set(system_ledger.gate_results("").values()), {"not-run"})

    def test_fail_beats_pass_and_unverified_beats_pass(self):
        text = "G1 pass: a\nG2 pass: b\nG2 FAIL: c\nG7 unverified: d\nG7 pass: e\nnoise\nG9 pass: x\n"
        results = system_ledger.gate_results(text)
        self.assertEqual((results["G1"], results["G2"], results["G7"], results["G3"]), ("pass", "FAIL", "unverified", "not-run"))

    def test_the_gate_string_is_strict(self):
        self.assertEqual(system_ledger.parse_gate_string(GOOD_GATES)["G4"], "pass")
        for bad in ("", "G1=pass; id", "G1=maybe", "G8=pass"):
            with self.assertRaises(ValueError, msg=bad):
                system_ledger.parse_gate_string(bad)


class Plan(unittest.TestCase):
    def plan(self, gates, failure="", live=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        gates_file = pathlib.Path(tmp.name) / "gates.txt"
        gates_file.write_text(gates, encoding="utf-8")
        argv = ["plan", "--manifest", str(MANIFEST), "--current-manifest", str(MANIFEST), "--jira-key", JIRA,
                "--gates-file", str(gates_file), "--failure", failure, "--rollback-allowed", "true",
                "--erp-rollback-class", "image-only", "--environment-gate", "reviewed", "--out", tmp.name,
                "--generated-at", "2026-11-01T00:00:00Z"]
        code, _, _ = run_cli(*argv, *(["--live"] if live else []))
        return code, json.loads((pathlib.Path(tmp.name) / "ledger.json").read_text(encoding="utf-8")), tmp.name

    def test_all_rules_passing_is_planned(self):
        gates = "".join(f"{rule} pass: ok\n" for rule in system_ledger.RULES)
        code, ledger, tmp = self.plan(gates)
        self.assertEqual((code, ledger["outcome"], ledger["refusals"], ledger["mode"]), (0, "planned", [], "dry-run"))
        self.assertEqual(ledger["kind"], "rt1031-system-lab-planned-ledger")
        self.assertEqual(ledger["system"], "lab-2026.11.0")
        self.assertEqual([step["step"] for step in ledger["order"]], ["backup", "backend", "console", "erp"])
        self.assertEqual(ledger["backend"], {"rollbackAllowed": True})
        self.assertEqual(ledger["erp"], {"rollbackClass": "image-only"})
        self.assertIn("PLANNED", (pathlib.Path(tmp) / "summary.md").read_text(encoding="utf-8"))

    def test_a_failed_rule_refuses(self):
        code, ledger, _ = self.plan("G1 pass: ok\nG4 FAIL: a consumer PIN is incompatible\n")
        self.assertEqual((code, ledger["outcome"], ledger["refusals"]), (1, "refused", ["G4 failed"]))
        self.assertEqual(ledger["gates"]["G4"], "FAIL")

    def test_a_failed_step_refuses_even_without_a_failed_rule(self):
        code, ledger, _ = self.plan("G1 pass: ok\n", failure="preflight step console failed")
        self.assertEqual((code, ledger["outcome"]), (1, "refused"))
        self.assertIn("preflight step console failed", ledger["refusals"])

    def test_a_live_plan_says_so(self):
        self.assertEqual(self.plan("", live=True)[1]["mode"], "live")


class Final(unittest.TestCase):
    def final(self, ok, lines=None, failure=None, current=None, rollback_allowed="false", erp_class="restore"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        live = pathlib.Path(tmp.name) / "live"
        live.mkdir()
        write_live(live, ok, lines, failure)
        current_path = current or write_current(tmp.name)
        out = pathlib.Path(tmp.name) / "out"
        code, _, err = run_cli("final", "--manifest", str(MANIFEST), "--current-manifest", str(current_path), "--jira-key", JIRA,
                               "--live-dir", str(live), "--gates", GOOD_GATES, "--rollback-allowed", rollback_allowed,
                               "--erp-rollback-class", erp_class, "--out", str(out), "--generated-at", "2026-11-01T00:00:00Z")
        self.assertEqual((code, err), (0, ""))
        return json.loads((out / "ledger.json").read_text(encoding="utf-8")), (out / "summary.md").read_text(encoding="utf-8")

    LINES = {
        "backup": [BACKUP_LINE],
        "backend": ["RT_GATE G-Host pass", "RT_PRIOR release=backend-core/v0.3.1 api=sha256:" + "d" * 64, "RT_DONE release=backend-core/v0.3.2"],
        "console": ["RT_GATE G-Host pass", "RT_PRIOR current=admin-console/v0.0.9", "RT_SWAP from=admin-console/v0.0.9", "RT_DONE release=admin-console/v0.1.0"],
        "erp": ["RT_GATE site=pass", "RT_GATE verify=pass", "RT_DIGEST_AFTER=sha256:" + "e" * 64, "RT_OUTCOME=deployed"],
    }

    def test_every_step_done_is_deployed(self):
        ledger, summary = self.final(["backup", "backend", "console", "erp"], self.LINES)
        self.assertEqual((ledger["outcome"], ledger["failure"], ledger["kind"]), ("deployed", None, "rt1031-system-lab-live-ledger"))
        self.assertEqual([(s["step"], s["state"]) for s in ledger["steps"]],
                         [("backup", "ok"), ("backend", "ok"), ("console", "ok"), ("erp", "ok")])
        self.assertIn("DEPLOYED", summary)

    def test_each_step_carries_its_prior_and_target_version(self):
        ledger, _ = self.final(["backup", "backend", "console", "erp"], self.LINES)
        steps = {s["step"]: s for s in ledger["steps"]}
        self.assertEqual(steps["backend"]["prior"]["release"], "backend-core/v0.3.1")
        self.assertEqual(steps["backend"]["target"], {"release": "backend-core/v0.3.2"})
        self.assertEqual(steps["console"]["target"], {"release": "admin-console/v0.1.0"})
        self.assertEqual(steps["erp"]["prior"]["image"], OLD_IMAGE)
        self.assertEqual(steps["erp"]["target"]["sha"], json.loads(MANIFEST.read_text(encoding="utf-8"))["erpnext"]["sha"])
        self.assertEqual(steps["backup"]["target"]["name"], "rtlab-v0.3.1-to-v0.3.2-20261101T080000Z.dump")
        self.assertEqual(steps["backend"]["gates"], [{"gate": "G-Host", "result": "pass"}])
        self.assertEqual(steps["erp"]["gates"], [{"gate": "site", "result": "pass"}, {"gate": "verify", "result": "pass"}])
        self.assertEqual((steps["backup"]["document"], steps["backup"]["host"]), ("RT-BackendLabBackup", "lab-02"))
        self.assertEqual((steps["erp"]["document"], steps["erp"]["host"]), ("RT-ErpLabDeploy", "lab-03"))

    def test_the_gate_results_are_recorded(self):
        ledger, _ = self.final(["backup", "backend", "console", "erp"], self.LINES)
        self.assertEqual(set(ledger["gates"].values()), {"pass"})

    def test_a_failure_stops_at_that_step_and_the_rest_did_not_run(self):
        ledger, summary = self.final(["backup"], {"backup": self.LINES["backup"], "backend": ["RT_FAIL gate=G-Host"]},
                                     failure="backend: the document ended Failed")
        self.assertEqual(ledger["outcome"], "failed-at:backend")
        self.assertEqual([s["state"] for s in ledger["steps"]], ["ok", "failed", "not-run", "not-run"])
        self.assertEqual(ledger["failure"], {"step": "backend", "reason": "backend: the document ended Failed"})
        self.assertIn("Failure boundary: backend: the document ended Failed", summary)

    def test_a_failed_backend_step_leaves_nothing_to_roll_back(self):
        ledger, _ = self.final(["backup"], {"backup": self.LINES["backup"]}, failure="backend: the document ended Failed")
        self.assertEqual(ledger["manualRollback"], [])

    def test_a_failed_console_step_rolls_back_only_the_backend_with_the_migration_rule(self):
        ledger, _ = self.final(["backup", "backend"], {"backup": self.LINES["backup"], "backend": self.LINES["backend"]},
                               failure="console: the document ended Failed")
        self.assertEqual(ledger["outcome"], "failed-at:console")
        (backend,) = ledger["manualRollback"]
        self.assertEqual((backend["step"], backend["workflow"]), ("backend", "deploy-lab.yml"))
        self.assertEqual(backend["inputs"], {"backend_release": "backend-core/v0.3.1", "current_release": "backend-core/v0.3.2",
                                             "target": "lab-01", "jira_key": JIRA, "dry_run": False})
        self.assertIn("NOT allowed", backend["note"])
        self.assertEqual(backend["backup"]["sha256"], "a" * 64)

    def test_an_app_only_rollback_is_named_when_the_forward_deploy_added_no_migration(self):
        ledger, _ = self.final(["backup", "backend"], {"backup": self.LINES["backup"], "backend": self.LINES["backend"]},
                               failure="console: x", rollback_allowed="true")
        self.assertIn("app-only rollback is allowed", ledger["manualRollback"][0]["note"])

    def test_a_failed_erp_step_rolls_back_the_console_then_the_backend(self):
        ledger, _ = self.final(["backup", "backend", "console"], {k: v for k, v in self.LINES.items() if k != "erp"},
                               failure="erp: the document ended Failed")
        self.assertEqual(ledger["outcome"], "failed-at:erp")
        self.assertEqual([item["step"] for item in ledger["manualRollback"]], ["console", "backend"])
        console = ledger["manualRollback"][0]
        self.assertEqual(console["workflow"], "deploy-console-lab.yml")
        self.assertEqual(console["inputs"]["console_release"], "admin-console/v0.0.9")
        self.assertEqual(console["inputs"]["backend_release"], "backend-core/v0.3.1")

    def test_a_deployed_system_names_the_erp_rollback_inputs_last_deployed_first(self):
        ledger, _ = self.final(["backup", "backend", "console", "erp"], self.LINES, erp_class="image-only")
        self.assertEqual([item["step"] for item in ledger["manualRollback"]], ["erp", "console", "backend"])
        erp = ledger["manualRollback"][0]
        target = json.loads(MANIFEST.read_text(encoding="utf-8"))["erpnext"]
        self.assertEqual(erp["workflow"], "deploy-erp-lab.yml")
        self.assertEqual((erp["inputs"]["target_sha"], erp["inputs"]["current_sha"]), (OLD_SHA, target["sha"]))
        self.assertEqual(erp["inputs"]["target_digest"], "sha256:" + "b" * 64)
        images = json.loads(erp["inputs"]["current_images"])
        self.assertEqual(sorted(images), sorted(system_ledger.ERP_SERVICES))
        self.assertEqual(set(images.values()), {target["image"]})
        self.assertFalse(erp["inputs"]["hold"] or erp["inputs"]["dry_run"])
        self.assertIn("image-only", erp["note"])

    def test_a_job_that_died_before_any_document_fails_at_the_first(self):
        ledger, _ = self.final([])
        self.assertEqual(ledger["outcome"], "failed-at:backup")
        self.assertEqual([s["state"] for s in ledger["steps"]], ["failed", "not-run", "not-run", "not-run"])
        self.assertIn("RT-BackendLabBackup", ledger["failure"]["reason"])

    def test_a_malformed_gate_string_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = pathlib.Path(tmp) / "live"
            live.mkdir()
            code, _, err = run_cli("final", "--manifest", str(MANIFEST), "--current-manifest", str(MANIFEST), "--jira-key", JIRA,
                                   "--live-dir", str(live), "--gates", "G1=pass; id", "--out", str(pathlib.Path(tmp) / "out"))
            self.assertEqual(code, 2)
            self.assertIn("--gates", err)


if __name__ == "__main__":
    unittest.main()
