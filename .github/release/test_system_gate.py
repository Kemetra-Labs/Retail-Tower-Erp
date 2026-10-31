"""Spec for .github/release/system_gate.py (RT-1030). Run: python -m unittest discover -s .github/release -v"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import system_gate  # noqa: E402

PIN = ("repo: Kemetra-Labs/Retail-Tower-Erp\ncommit: {c}\n"
       "source: services/backend-core/packages/contracts/openapi\nfile: a.yaml " + "0" * 40 + "\n")
SUPPORTED = """schema: retail-tower/pos-compat@1
fleet_baseline:
  installed:
    - kind: build
      build_id: {installed}
supported:
  - kind: build
    build_id: {build}
    pos_pin:
      bc_commit: {other}
"""
BUILD = "9" * 40
INSTALLED_ONLY = "8" * 40


def sh(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout.strip()


class SystemGateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        repo = cls.repo = os.path.join(cls.tmp.name, "repo")
        sh(cls.tmp.name, "init", "-q", "-b", "main", repo)

        def commit(files, msg):
            for rel, text in files.items():
                p = pathlib.Path(repo, rel)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text)
            sh(repo, "add", ".")
            sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg)
            return sh(repo, "rev-parse", "HEAD")

        cls.bc = commit({system_gate.POS_SUPPORTED: SUPPORTED.format(installed=INSTALLED_ONLY, build=BUILD, other="1" * 40)}, "backend")
        sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "-m", "r", "backend-core/v1.0.0", cls.bc)
        cls.console = commit({system_gate.CONSOLE_PIN: PIN.format(c=cls.bc)}, "console")
        sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "-m", "r", "admin-console/v1.0.0", cls.console)
        cls.erp = commit({"integrations/erpnext-connector/x.py": "x = 1\n"}, "erp")
        # A Console release whose PIN names another Backend commit.
        cls.stale = commit({system_gate.CONSOLE_PIN: PIN.format(c="2" * 40)}, "stale console")
        sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "-m", "r", "admin-console/v0.9.0", cls.stale)
        # A commit off main.
        sh(repo, "checkout", "-q", "-b", "side", cls.erp)
        cls.side = commit({"side.txt": "s\n"}, "side")
        sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "-m", "r", "backend-core/v9.9.9", cls.side)
        sh(repo, "checkout", "-q", "main")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def manifest(self, name="lab-2026.11.0", **override):
        data = {
            "schema": system_gate.SCHEMA,
            "system": name,
            "backendCore": {"release": "backend-core/v1.0.0"},
            "adminConsole": {"release": "admin-console/v1.0.0"},
            "erpnext": {"image": "ghcr.io/kemetra-labs/rt-erpnext@sha256:" + "a" * 64, "sha": self.erp},
            "pos": {"build": BUILD},
        }
        for key, value in override.items():
            if value is None:
                data.pop(key)
            else:
                data[key] = value
        path = pathlib.Path(tempfile.mkdtemp(dir=self.tmp.name), f"{name}.json")
        path.write_text(json.dumps(data))
        return str(path)

    def gate(self, path):
        return system_gate.evaluate(self.repo, path, "main")

    def failed(self, results):
        return {rule for rule, ok, _ in results if not ok}

    def test_compatible_system_passes_every_rule(self):
        results = self.gate(self.manifest())
        self.assertEqual(self.failed(results), set())
        self.assertEqual([r for r, _, _ in results], ["G1", "G2", "G3", "G5"])
        self.assertEqual(system_gate.main(["--repo", self.repo, "--manifest", self.manifest(), "--main", "main"]), 0)

    def test_g1_refuses_an_unknown_key_a_missing_key_and_a_bad_value(self):
        self.assertEqual(self.failed(self.gate(self.manifest(extra={"x": 1}))), {"G1"})
        self.assertEqual(self.failed(self.gate(self.manifest(pos=None))), {"G1"})
        self.assertEqual(self.failed(self.gate(self.manifest(backendCore={"release": "backend-core/latest"}))), {"G1"})
        self.assertEqual(self.failed(self.gate(self.manifest(erpnext={"image": "rt-erpnext:latest", "sha": self.erp}))), {"G1"})

    def test_g1_refuses_a_file_name_that_is_not_the_system_name(self):
        path = self.manifest()
        renamed = pathlib.Path(path).with_name("lab-2026.12.0.json")
        os.rename(path, renamed)
        self.assertEqual(self.failed(self.gate(str(renamed))), {"G1"})

    def test_g1_failure_stops_before_git_rules(self):
        results = self.gate(self.manifest(schema="other"))
        self.assertEqual([r for r, _, _ in results], ["G1"])
        self.assertEqual(system_gate.main(["--repo", self.repo, "--manifest", self.manifest(schema="other"), "--main", "main"]), 1)

    def test_g2_refuses_a_missing_tag(self):
        results = self.gate(self.manifest(adminConsole={"release": "admin-console/v7.0.0"}))
        self.assertIn("G2", self.failed(results))

    def test_g2_refuses_a_release_or_commit_that_is_not_on_main(self):
        self.assertIn("G2", self.failed(self.gate(self.manifest(backendCore={"release": "backend-core/v9.9.9"}))))
        image = "ghcr.io/kemetra-labs/rt-erpnext@sha256:" + "a" * 64
        self.assertEqual(self.failed(self.gate(self.manifest(erpnext={"image": image, "sha": self.side}))), {"G2"})

    def test_g3_refuses_a_console_pinned_to_another_backend(self):
        results = self.gate(self.manifest(adminConsole={"release": "admin-console/v0.9.0"}))
        self.assertEqual(self.failed(results), {"G3"})
        detail = dict((r, d) for r, _, d in results)["G3"]
        self.assertIn("2" * 40, detail)
        self.assertIn(self.bc, detail)

    def test_g5_refuses_a_pos_build_outside_the_supported_list(self):
        self.assertEqual(self.failed(self.gate(self.manifest(pos={"build": "7" * 40}))), {"G5"})
        # installed but not supported, and a bc_commit value, are not membership
        self.assertEqual(self.failed(self.gate(self.manifest(pos={"build": INSTALLED_ONLY}))), {"G5"})
        self.assertEqual(self.failed(self.gate(self.manifest(pos={"build": "1" * 40}))), {"G5"})

    def test_contracts_args_name_the_release_commits(self):
        out = system_gate.contracts_args(self.repo, json.loads(pathlib.Path(self.manifest()).read_text()))
        self.assertEqual(out, ["--backend-rev", self.bc,
                               "--consumer-rev", f"Admin-Console={self.console}",
                               "--consumer-rev", f"ERPNext-Connector={self.erp}"])

    def test_unreadable_manifest_is_a_usage_error(self):
        self.assertEqual(system_gate.main(["--repo", self.repo, "--manifest", os.path.join(self.tmp.name, "nope.json"), "--main", "main"]), 2)


if __name__ == "__main__":
    unittest.main()
