"""RT-1242: tests of the `sourcemaps` mode of sentry-release.sh and of the Console release wiring.

The stub sentry-cli of test_sentry_release.py stands in for the pinned binary. The workflow checks
read release-admin-console.yml as text (the release/selftest job has no PyYAML): maps leave dist/
before it is checked, archived and hashed, the archive is asserted to hold 0 maps, and only the
publish job (environment-protected) reads the token. The map-move step and the archive assertion are
also executed with bash against a temporary dist/.
"""
import os
import re
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from test_sentry_release import BASH, HAVE_BASH, SCRIPT, STUB, WORKFLOWS

SHA = "0123456789abcdef0123456789abcdef01234567"
RELEASE = SHA[:12]
ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = WORKFLOWS / "release-admin-console.yml"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def job(text: str, name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"job {name} missing")
    return match.group(1)


def step_block(text: str, name: str) -> str:
    match = re.search(rf"^      - name: {re.escape(name)}.*?\n(.*?)(?=^      - name: |^      # |\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"step {name} missing")
    return match.group(1)


def step_script(text: str, name: str) -> str:
    """The `run: |` body of the step, dedented as Actions runs it."""
    body = re.search(r"^        run: \|\n((?:          .*\n|\n)+)", step_block(text, name), re.M)
    if not body:
        raise AssertionError(f"step {name} has no run script")
    return "\n".join(line[10:] for line in body.group(1).split("\n"))


def posix(path: Path) -> str:
    """A path bash's tar reads as local on Windows too (`C:` would be taken for a remote host)."""
    s = path.as_posix()
    return f"/{s[0].lower()}{s[2:]}" if os.name == "nt" and len(s) > 1 and s[1] == ":" else s


def step_names(text: str) -> list[str]:
    return re.findall(r"^      - name: (.*)$", text, re.M)


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


@unittest.skipUnless(HAVE_BASH, "bash not available")
class ReleaseStepsRunForReal(unittest.TestCase):
    """The map-move step and the 0-maps archive assertion, executed with bash."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.app = self.tmp / "app"
        (self.app / "dist" / "assets").mkdir(parents=True)
        (self.app / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
        for name in ("index-a", "react-vendor-b"):
            (self.app / "dist" / "assets" / f"{name}.js").write_text("js", encoding="utf-8")
            (self.app / "dist" / "assets" / f"{name}.js.map").write_text("{}", encoding="utf-8")
        self.runner_temp = self.tmp / "runner"
        self.runner_temp.mkdir()
        self.text = read(WORKFLOW)

    def run_bash(self, script, cwd, **env):
        full = {**os.environ, "RUNNER_TEMP": str(self.runner_temp), **env}
        return subprocess.run([BASH, "-c", script], capture_output=True, text=True, cwd=cwd, env=full, check=False)

    def test_move_step_empties_dist_of_maps_and_keeps_the_js_beside_them(self):
        out = self.run_bash(step_script(job(self.text, "build"), "Move the source maps out of dist/"), self.app)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(sorted(p.name for p in (self.app / "dist").rglob("*.map")), [])
        self.assertTrue((self.app / "dist" / "assets" / "index-a.js").exists())
        moved = self.runner_temp / "admin-sourcemaps" / "assets"
        self.assertEqual(sorted(p.name for p in moved.iterdir()), ["index-a.js", "index-a.js.map", "react-vendor-b.js", "react-vendor-b.js.map"])
        self.assertIn("2 source maps moved", (self.runner_temp / "admin-sourcemaps" / "maps.txt").read_text(encoding="utf-8"))

    def test_move_step_with_no_maps_warns_and_still_succeeds(self):
        for m in (self.app / "dist" / "assets").glob("*.map"):
            m.unlink()
        out = self.run_bash(step_script(job(self.text, "build"), "Move the source maps out of dist/"), self.app)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("::warning::RT-1242", out.stdout)

    def package_script(self):
        return step_script(job(self.text, "build"), "Package dist/")

    def build_archive(self, with_map):
        out_dir = self.runner_temp / "admin-release"
        out_dir.mkdir(exist_ok=True)
        archive = out_dir / "admin-console-v0.0.1.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(self.app / "dist" / "index.html", arcname="./index.html")
            if with_map:
                tar.add(self.app / "dist" / "assets" / "index-a.js.map", arcname="./assets/index-a.js.map")
        return archive

    def assertion_part(self):
        script = self.package_script()
        return script[script.index('listing="$(tar -tzf'):]

    def test_archive_assertion_passes_with_zero_maps_and_fails_with_one(self):
        archive = self.build_archive(with_map=False)
        env = {"out": posix(archive.parent), "ARTIFACT": archive.name}
        ok = self.run_bash("set -euo pipefail\n" + self.assertion_part(), self.tmp, **env)
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        archive = self.build_archive(with_map=True)
        bad = self.run_bash("set -euo pipefail\n" + self.assertion_part(), self.tmp, **env)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("holds 1 .map files", bad.stdout)

    def test_archive_assertion_stops_on_a_broken_archive_instead_of_reading_zero_maps(self):
        archive = self.runner_temp / "admin-release" / "admin-console-v0.0.1.tar.gz"
        archive.parent.mkdir()
        archive.write_bytes(b"not a tarball")
        out = self.run_bash("set -euo pipefail\n" + self.assertion_part(), self.tmp, out=posix(archive.parent), ARTIFACT=archive.name)
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("archive holds 0 .map files", out.stdout)


class ConsoleReleaseWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = read(WORKFLOW)
        cls.build = job(cls.text, "build")
        cls.publish = job(cls.text, "publish")

    def test_vite_builds_hidden_maps(self):
        self.assertRegex(read(ROOT / "apps/admin-console/vite.config.ts"), r'sourcemap:\s*"hidden"')

    def test_maps_leave_dist_before_it_is_checked_archived_and_hashed(self):
        names = step_names(self.build)
        move = names.index("Move the source maps out of dist/")
        self.assertLess(names.index("Build"), move)
        self.assertLess(move, names.index("Write version.json"))
        self.assertLess(move, names.index("Package dist/"))
        self.assertIn("find dist -name '*.map' -delete", step_script(self.build, "Move the source maps out of dist/"))

    def test_the_archive_is_asserted_to_hold_zero_maps(self):
        package = step_script(self.build, "Package dist/")
        self.assertIn('listing="$(tar -tzf "$out/$ARTIFACT")"', package)
        self.assertIn("grep -c '\\.map$'", package)
        self.assertIn('[ "$maps" -eq 0 ]', package)

    def test_only_publish_reads_the_token_and_the_build_job_stays_secret_free(self):
        self.assertEqual(len(re.findall(r"secrets\.SENTRY_AUTH_TOKEN", self.text)), 1)
        self.assertIn("secrets.SENTRY_AUTH_TOKEN", self.publish)
        self.assertNotIn("secrets.", self.build)
        self.assertIn("environment: release-admin-console", self.publish)

    def test_publish_uploads_after_the_release_exists_with_the_runtime_release_name(self):
        names = step_names(self.publish)
        self.assertLess(names.index("Create the GitHub release (never overwrites)"), names.index("Upload the source maps to Sentry (evidence only)"))
        block = step_block(self.publish, "Upload the source maps to Sentry (evidence only)")
        self.assertIn("timeout-minutes: 6", block)
        self.assertNotIn("continue-on-error", block)
        script = step_script(self.publish, "Upload the source maps to Sentry (evidence only)")
        self.assertIn('sentry-release.sh sourcemaps admin-console "${SHA:0:12}" "$SHA"', script)
        self.assertIn("timeout 240", script)
        self.assertTrue(script.startswith("set -euo pipefail\n"))

    def test_the_maps_artifact_is_separate_from_the_package(self):
        self.assertIn("admin-console-sourcemaps-${{ needs.resolve.outputs.mode }}-${{ github.run_id }}", self.text)
        self.assertIn("admin-console-package-", step_block(job(self.text, "manifest"), "Download the package"))

    def test_the_parity_manifest_does_not_hash_the_maps(self):
        ci = read(WORKFLOWS / "admin-console.yml")
        self.assertIn("find . -type f ! -name '*.map' -print0", ci)


if __name__ == "__main__":
    unittest.main()
