"""RT-1242: tests of the `sourcemaps` mode of sentry-release.sh and of the Console release wiring.

The stub sentry-cli of test_sentry_release.py stands in for the pinned binary. The workflow checks
read release-admin-console.yml: maps leave dist/ before it is checked, archived and hashed, the
archive is asserted to hold 0 maps, and only the publish job (environment-protected) reads the token.
"""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

from test_sentry_release import BASH, HAVE_BASH, SCRIPT, STUB, WORKFLOWS

SHA = "0123456789abcdef0123456789abcdef01234567"
RELEASE = SHA[:12]
ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(HAVE_BASH, "bash not available")
class SourcemapsMode(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        cli = self.tmp / "sentry-cli"
        cli.write_text(STUB, encoding="utf-8", newline="\n")
        cli.chmod(0o755)
        self.cli, self.log = cli, self.tmp / "cli.log"
        self.maps = self.tmp / "maps"
        (self.maps / "assets").mkdir(parents=True)
        (self.maps / "assets" / "index-abc.js").write_text("x", encoding="utf-8")
        (self.maps / "assets" / "index-abc.js.map").write_text("{}", encoding="utf-8")

    def run_script(self, args=None, token="secret-token-value", **extra):
        env = {k: v for k, v in os.environ.items() if k != "SENTRY_AUTH_TOKEN"}
        env.update({"SENTRY_CLI_BIN": str(self.cli), "STUB_LOG": str(self.log)})
        if token:
            env["SENTRY_AUTH_TOKEN"] = token
        env.update(extra)
        args = args or ["sourcemaps", "admin-console", RELEASE, SHA, str(self.maps)]
        out = subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True, cwd=self.tmp, env=env, check=False)
        return out, (self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else [])

    def test_uploads_by_release_and_url_prefix_without_inject_or_rewrite(self):
        out, calls = self.run_script()
        self.assertEqual(out.returncode, 0)
        base = "org=kemetra url=https://de.sentry.io project=admin-console"
        self.assertEqual(calls, [
            f"releases new {RELEASE} | {base}",
            f"sourcemaps upload --release {RELEASE} --url-prefix ~/assets --no-rewrite {self.maps}/assets | {base}",
        ])
        self.assertFalse([c for c in calls if " inject" in c])
        self.assertNotIn("secret-token-value", out.stdout + out.stderr)

    def test_missing_token_warns_once_and_succeeds(self):
        out, calls = self.run_script(token="")
        self.assertEqual((out.returncode, calls), (0, []))
        self.assertEqual(out.stdout.count("::warning::"), 1)

    def test_no_maps_is_a_warning_and_uploads_nothing(self):
        (self.maps / "assets" / "index-abc.js.map").unlink()
        out, calls = self.run_script()
        self.assertEqual((out.returncode, calls), (0, []))
        self.assertIn("no *.js.map files", out.stdout)

    def test_bad_inputs_are_skipped_with_a_warning(self):
        for args in (["sourcemaps", "backend-core", RELEASE, SHA, str(self.maps)],
                     ["sourcemaps", "admin-console", "v1.2.3", SHA, str(self.maps)],
                     ["sourcemaps", "admin-console", "aaaaaaaaaaaa", SHA, str(self.maps)],
                     ["sourcemaps", "admin-console", RELEASE, "abc", str(self.maps)]):
            out, calls = self.run_script(args)
            self.assertEqual((out.returncode, calls), (0, []), args)
            self.assertIn("::warning::", out.stdout)

    def test_a_cli_failure_is_a_warning_never_a_failed_step(self):
        for fail in ("releases-new", "sourcemaps-upload"):
            self.log.unlink(missing_ok=True)
            out, _ = self.run_script(STUB_FAIL=fail)
            self.assertEqual(out.returncode, 0, fail)
            self.assertIn("::warning::", out.stdout, fail)


class ConsoleReleaseWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (WORKFLOWS / "release-admin-console.yml").read_text(encoding="utf-8")
        cls.jobs = yaml.safe_load(cls.text)["jobs"]

    @staticmethod
    def names(job):
        return [s.get("name", "") for s in job["steps"]]

    def step(self, job, name):
        return next(s for s in self.jobs[job]["steps"] if s.get("name") == name)

    def test_vite_builds_hidden_maps(self):
        vite = (ROOT / "apps/admin-console/vite.config.ts").read_text(encoding="utf-8")
        self.assertRegex(vite, r'sourcemap:\s*"hidden"')

    def test_maps_leave_dist_before_it_is_checked_archived_and_hashed(self):
        names = self.names(self.jobs["build"])
        move = names.index("Move the source maps out of dist/")
        self.assertLess(names.index("Build"), move)
        self.assertLess(move, names.index("Write version.json"))
        self.assertLess(move, names.index("Package dist/"))
        self.assertIn("find dist -name '*.map' -delete", self.step("build", "Move the source maps out of dist/")["run"])

    def test_the_archive_is_asserted_to_hold_zero_maps(self):
        package = self.step("build", "Package dist/")["run"]
        # a tar failure must stop the step, not read as "0 maps"
        self.assertIn('listing="$(tar -tzf "$out/$ARTIFACT")"', package)
        self.assertIn("grep -c '\\.map$'", package)
        self.assertIn('[ "$maps" -eq 0 ]', package)

    def test_only_publish_reads_the_token_and_the_build_job_stays_secret_free(self):
        for name, job in self.jobs.items():
            self.assertEqual("secrets.SENTRY_AUTH_TOKEN" in yaml.safe_dump(job), name == "publish", name)
        self.assertEqual(len(re.findall(r"secrets\.SENTRY_AUTH_TOKEN", self.text)), 1)
        self.assertEqual(self.jobs["publish"]["environment"], "release-admin-console")

    def test_publish_uploads_after_the_release_exists_with_the_runtime_release_name(self):
        names = self.names(self.jobs["publish"])
        self.assertLess(names.index("Create the GitHub release (never overwrites)"), names.index("Upload the source maps to Sentry (evidence only)"))
        step = self.step("publish", "Upload the source maps to Sentry (evidence only)")
        self.assertEqual(step["timeout-minutes"], 6)
        self.assertNotIn("continue-on-error", step)
        self.assertIn('sentry-release.sh sourcemaps admin-console "${SHA:0:12}" "$SHA"', step["run"])
        self.assertIn("timeout 240", step["run"])
        self.assertTrue(step["run"].startswith("set -euo pipefail\n"))

    def test_the_maps_artifact_is_separate_from_the_package(self):
        self.assertIn("admin-console-sourcemaps-${{ needs.resolve.outputs.mode }}-${{ github.run_id }}", self.text)
        self.assertIn("admin-console-package-", self.step("manifest", "Download the package")["with"]["name"])


if __name__ == "__main__":
    unittest.main()
