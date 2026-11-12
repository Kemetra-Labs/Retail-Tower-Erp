"""RT-1366: the opt-in Depot CI pre-push preflight stays dispatch-only, read-only and fail-closed.

Offline only: parses .depot/workflows/preflight.yml and runs .depot/scripts/patch-evidence.sh in
throwaway git repositories. No Depot run is started."""

import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

import yaml

import support

REPO_ROOT = support.PG_ROOT.parents[1]
WORKFLOW = REPO_ROOT / ".depot/workflows/preflight.yml"
SCRIPT = REPO_ROOT / ".depot/scripts/patch-evidence.sh"
BASH = shutil.which("bash")


class WorkflowShapeTests(unittest.TestCase):

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")
        self.wf = yaml.safe_load(self.text)
        # PyYAML reads the key `on` as boolean True
        self.on = self.wf.get("on", self.wf.get(True))

    def test_workflow_dispatch_is_the_only_trigger(self):
        self.assertEqual(list(self.on), ["workflow_dispatch"])

    def test_token_is_read_only(self):
        self.assertEqual(self.wf["permissions"], {"contents": "read"})
        for job in self.wf["jobs"].values():
            self.assertNotIn("permissions", job)

    def test_no_secrets_publishing_or_deploy(self):
        self.assertNotIn("secrets.", self.text)
        self.assertNotIn("id-token", self.text)
        for word in ("docker push", "docker login", "aws ", "npm publish", "gh release"):
            self.assertNotIn(word, self.text)

    def test_suite_input_is_limited_to_db_and_worker(self):
        suite = self.on["workflow_dispatch"]["inputs"]["suite"]
        self.assertEqual(sorted(suite["options"]), ["both", "db", "worker"])
        self.assertIn("expected_files", self.on["workflow_dispatch"]["inputs"])

    def test_the_two_proven_commands_are_present(self):
        self.assertIn("pnpm --filter @data-pulse-2/db test", self.text)
        self.assertIn("pnpm --filter @data-pulse-2/worker test", self.text)
        self.assertIn('WORKER_INCLUDE_DB_TESTS: "1"', self.text)

    def test_every_action_is_pinned_to_a_full_sha(self):
        for ref in re.findall(r"uses:\s*(\S+)", self.text):
            self.assertRegex(ref, r"@[0-9a-f]{40}$", ref)


@unittest.skipIf(BASH is None, "bash not available")
class PatchEvidenceScriptTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = pathlib.Path(self._tmp.name)
        self._git("init", "-q")
        self._git("config", "user.email", "t@example.invalid")
        self._git("config", "user.name", "t")
        self._write("a.txt", "one\n")
        self._git("add", "a.txt")
        self._git("commit", "-q", "-m", "base")

    def _git(self, *args):
        subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

    def _write(self, rel, text):
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")

    def _run(self, expected="", expected_file=""):
        env = {**os.environ, "EXPECTED_FILES": expected, "EXPECTED_FILE": expected_file}
        return subprocess.run([BASH, str(SCRIPT)], cwd=self.repo, env=env, capture_output=True, text=True)

    def test_new_file_registered_with_intent_to_add_is_present_with_its_sha256(self):
        self._write("new.ts", "export {};\n")
        self._git("add", "-N", "new.ts")
        r = self._run("new.ts")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        digest = hashlib.sha256((self.repo / "new.ts").read_bytes()).hexdigest()
        self.assertIn(f"PRESENT  {digest}  new.ts", r.stdout)
        self.assertIn(f"{digest}  new.ts", r.stdout.split("--- expected files")[0])

    def test_a_listed_file_that_is_missing_fails(self):
        r = self._run("a.txt, never-uploaded.ts")
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("FAIL  never-uploaded.ts", r.stdout)
        self.assertIn("patch evidence FAILED", r.stdout)

    def test_a_github_workflows_path_is_rejected_even_when_the_file_exists(self):
        self._write(".github/workflows/x.yml", "name: x\n")
        for listed in (".github/workflows/x.yml", "./.github/workflows/x.yml", ".github/workflows",
                       ".github//workflows/x.yml", ".github/./workflows/x.yml", ".//.github/workflows/x.yml/."):
            with self.subTest(listed=listed):
                r = self._run(listed)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertIn("not carried by depot ci run", r.stdout)

    def test_absolute_and_parent_paths_are_rejected(self):
        for listed in ("/etc/passwd", "../x", "a/../x", "C:/x"):
            with self.subTest(listed=listed):
                self.assertEqual(self._run(listed).returncode, 1)

    def test_a_glob_token_is_never_expanded(self):
        r = self._run("*")
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("FAIL  *", r.stdout)

    def test_non_ascii_path_is_listed_as_present_not_deleted(self):
        name = "é.txt"
        self._write(name, "x\n")
        self._git("add", "-N", name)
        r = self._run(name)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("(deleted)", r.stdout)

    def test_a_missing_list_file_is_called_out(self):
        r = self._run(expected_file="nope.txt")
        self.assertIn("nope.txt not found", r.stdout)

    def test_empty_list_passes_and_modified_tracked_file_is_listed(self):
        self._write("a.txt", "two\n")
        r = self._run("")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertRegex(r.stdout, r"[0-9a-f]{64}  a\.txt")

    def test_expected_files_can_come_from_a_file_with_comments(self):
        self._write("list.txt", "# comment\n\na.txt\nmissing.ts\n")
        r = self._run(expected_file="list.txt")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAIL  missing.ts", r.stdout)
        self.assertIn("PRESENT", r.stdout)


if __name__ == "__main__":
    unittest.main()
