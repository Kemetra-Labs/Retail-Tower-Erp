"""End-to-end CLI checks: the commands the selftest workflow and the staged
gate call, run as subprocesses against this repository."""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

PG = pathlib.Path(__file__).resolve().parents[1]
REPO = str(PG.parents[1])


def _cli(*args):
    return subprocess.run([sys.executable, "-m", "pgraph", *args], cwd=PG,
                          capture_output=True, text=True)


class CliTests(unittest.TestCase):

    def test_classify_tree_reports_counts_and_passes(self):
        r = _cli("classify-tree", "--repo", REPO, "--rev", "HEAD")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["unknown"], [])
        self.assertEqual(out["ambiguous"], [])
        self.assertGreater(out["product_paths"], 7000)

    def test_classify_tree_fails_on_unknown_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "-C", tmp, "init", "-q"], check=True)
            pathlib.Path(tmp, "foo").mkdir()
            pathlib.Path(tmp, "foo", "x.txt").write_text("x")
            subprocess.run(["git", "-C", tmp, "add", "-A"], check=True)
            subprocess.run(["git", "-C", tmp, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
                            "commit", "-q", "-m", "x"], check=True)
            r = _cli("classify-tree", "--repo", tmp, "--rev", "HEAD", "--graph", str(PG / "graph.yaml"))
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["unknown"], ["foo/x.txt"])

    def test_evaluate_then_aggregate_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = pathlib.Path(tmp, "plan.json")
            r = _cli("evaluate", "--repo", REPO, "--base", "HEAD", "--head", "HEAD",
                     "--event", "pull_request", "--out", str(plan_path))
            self.assertEqual(r.returncode, 0, r.stderr)
            plan = json.loads(plan_path.read_text())
            # Today the trusted graph fails rule 5 (no root product workflows),
            # so every evaluation fails closed. This is the recorded gap.
            self.assertEqual(plan["graph_validation"]["reasons"], ["GRAPH_INVALID"])
            pathlib.Path(tmp, "checks.json").write_text("[]")
            pathlib.Path(tmp, "approvals.json").write_text("[]")
            r = _cli("aggregate", "--plan", str(plan_path), "--checks", str(pathlib.Path(tmp, "checks.json")),
                     "--approvals", str(pathlib.Path(tmp, "approvals.json")), "--repo", REPO, "--base", "HEAD")
            self.assertEqual(r.returncode, 1)
            self.assertEqual(json.loads(r.stdout)["conclusion"], "failure")

    def test_normalize_writes_records_and_completion(self):
        head, base, fp = "2" * 40, "1" * 40, "a" * 64
        with tempfile.TemporaryDirectory() as tmp:
            t = pathlib.Path(tmp)
            (t / "runs.json").write_text(json.dumps({"workflow_runs": [
                {"id": 7, "path": ".github/workflows/pos.yml", "event": "pull_request", "head_sha": head,
                 "status": "in_progress", "repository": {"full_name": "o/r"}}]}))
            (t / "jobs.json").write_text(json.dumps({"7": [
                {"name": "pos/static", "run_attempt": 1, "head_sha": head, "status": "completed",
                 "conclusion": "success", "check_run_url": "https://api.github.com/repos/o/r/check-runs/9"}]}))
            (t / "checks.json").write_text(json.dumps({"check_runs": [{"id": 9, "app": {"id": 15368}}]}))
            (t / "reviews.json").write_text(json.dumps([
                {"user": {"login": "h", "type": "User"}, "state": "APPROVED", "commit_id": head,
                 "body": f"policy-change-approved: base={base} fingerprint={fp}"}]))
            r = _cli("normalize", "--repo-name", "o/r", "--workflow-runs", str(t / "runs.json"),
                     "--jobs", str(t / "jobs.json"), "--check-runs", str(t / "checks.json"),
                     "--reviews", str(t / "reviews.json"), "--out-checks", str(t / "out-c.json"),
                     "--out-approvals", str(t / "out-a.json"))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertFalse(json.loads(r.stdout)["all_runs_completed"])
            [rec] = json.loads((t / "out-c.json").read_text())
            self.assertEqual((rec["name"], rec["app_id"], rec["run_id"]), ("pos/static", 15368, 7))
            [appr] = json.loads((t / "out-a.json").read_text())
            self.assertEqual((appr["login"], appr["base_sha"]), ("h", base))

    def test_aggregate_with_missing_plan_file_is_no_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty = pathlib.Path(tmp, "e.json")
            empty.write_text("[]")
            r = _cli("aggregate", "--plan", str(pathlib.Path(tmp, "missing.json")), "--checks", str(empty),
                     "--approvals", str(empty), "--repo", REPO, "--base", "HEAD")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["reasons"], ["NO_PLAN"])


if __name__ == "__main__":
    unittest.main()
