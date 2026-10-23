"""Unit tests for dependency_review.py (RT-850). Stdlib only; a fake scanner stands in for osv-scanner.

The fake reads each `-L` file as JSON {"pkgs": [[ecosystem, name, version, [advisory ids]], ...]},
prints the osv-scanner `--format json --all-packages` shape (absolute source paths, no entry for
an empty lockfile) and exits 1 when any advisory is present. FAKE_RC forces an exit code with no
report; FAKE_FAIL_IN limits that to a run whose directory has this basename.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dependency_review as dr  # noqa: E402

FAKE = r'''
import json, os, sys
args = sys.argv[1:]
rc = os.environ.get("FAKE_RC")
if rc and os.environ.get("FAKE_FAIL_IN", os.path.basename(os.getcwd())) == os.path.basename(os.getcwd()):
    sys.exit(int(rc))
out = args[args.index("--output-file") + 1]
locks = [args[i + 1] for i, a in enumerate(args) if a == "-L"]
results, vulnerable = [], False
for lock in locks:
    pkgs = json.load(open(lock))["pkgs"]
    if not pkgs:
        continue
    entries = []
    for eco, name, ver, ids in pkgs:
        vulnerable = vulnerable or bool(ids)
        entries.append({"package": {"name": name, "version": ver, "ecosystem": eco},
                        "vulnerabilities": [{"id": i} for i in ids]})
    results.append({"source": {"path": os.path.abspath(lock), "type": "lockfile"}, "packages": entries})
json.dump({"results": results}, open(out, "w"))
sys.exit(1 if vulnerable else 0)
'''

NPM = "apps/pos/package-lock.json"
PNPM = "services/backend-core/pnpm-lock.yaml"
CLEAN = [["npm", "left-pad", "1.3.0", []]]
VULN = [["npm", "left-pad", "1.3.0", ["GHSA-aaaa"]]]


class DependencyReviewTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.head = os.path.join(self.tmp, "head")
        self.base = os.path.join(self.tmp, "base")
        os.makedirs(self.head)
        os.makedirs(self.base)
        fake = os.path.join(self.tmp, "fake_osv.py")
        with open(fake, "w", encoding="utf-8") as fh:
            fh.write(FAKE)
        self.osv = [sys.executable, fake]
        self.summary = os.path.join(self.tmp, "summary.md")
        for key in ("FAKE_RC", "FAKE_FAIL_IN"):
            self.addCleanup(os.environ.pop, key, None)

    def lock(self, root, rel, pkgs):
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"pkgs": pkgs}, fh)

    def run_main(self, *required):
        argv = ["--head", self.head, "--base", self.base, "--summary", self.summary]
        for part in self.osv:
            argv += ["--osv", part]
        for req in required:
            argv += ["--require", req]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return dr.main(argv)

    def read_summary(self):
        with open(self.summary, encoding="utf-8") as fh:
            return fh.read()

    def both(self, rel, head_pkgs, base_pkgs):
        self.lock(self.head, rel, head_pkgs)
        if base_pkgs is not None:
            self.lock(self.base, rel, base_pkgs)

    def test_clean_head_passes_and_summary_lists_package_counts(self):
        self.both(NPM, CLEAN, CLEAN)
        self.assertEqual(self.run_main(NPM), 0)
        self.assertIn(f"| `{NPM}` | 1 | 0 | 0 | 0 |", self.read_summary())

    def test_new_vulnerable_package_fails(self):
        self.both(NPM, VULN, CLEAN)
        self.assertEqual(self.run_main(NPM), 1)
        self.assertIn("GHSA-aaaa", self.read_summary())

    def test_pre_existing_finding_unchanged_passes(self):
        self.both(NPM, VULN, VULN)
        self.assertEqual(self.run_main(NPM), 0)

    def test_version_bump_into_a_vulnerable_version_fails(self):
        self.both(NPM, [["npm", "left-pad", "1.3.1", ["GHSA-aaaa"]]], VULN)
        self.assertEqual(self.run_main(NPM), 1)

    def test_same_finding_in_another_lockfile_is_new(self):
        self.both(NPM, VULN, VULN)
        self.both(PNPM, VULN, CLEAN)
        self.assertEqual(self.run_main(NPM, PNPM), 1)

    def test_lockfile_new_in_the_pr_counts_every_finding_as_new(self):
        self.both(NPM, CLEAN, CLEAN)
        self.both(PNPM, VULN, None)
        self.assertEqual(self.run_main(NPM, PNPM), 1)

    def test_unlisted_lockfile_in_a_new_directory_is_still_scanned(self):
        self.both(NPM, CLEAN, CLEAN)
        self.both("apps/new/uv.lock", VULN, None)
        self.assertEqual(self.run_main(NPM), 1)

    def test_required_lockfile_missing_fails_closed(self):
        self.both(NPM, CLEAN, CLEAN)
        self.assertEqual(self.run_main(NPM, PNPM), 2)

    def test_required_lockfile_with_zero_packages_fails_closed(self):
        self.both(NPM, [], [])
        self.assertEqual(self.run_main(NPM), 2)

    def test_scanner_general_error_fails_closed(self):
        self.both(NPM, CLEAN, CLEAN)
        os.environ["FAKE_RC"] = "127"
        self.assertEqual(self.run_main(NPM), 2)

    def test_scanner_no_packages_found_fails_closed(self):
        self.both(NPM, CLEAN, CLEAN)
        os.environ["FAKE_RC"] = "128"
        self.assertEqual(self.run_main(NPM), 2)

    def test_base_scan_error_fails_closed(self):
        self.both(NPM, CLEAN, CLEAN)
        os.environ["FAKE_RC"] = "127"
        os.environ["FAKE_FAIL_IN"] = "base"
        self.assertEqual(self.run_main(NPM), 2)

    def test_no_lockfile_at_all_fails_closed(self):
        self.assertEqual(self.run_main(NPM), 2)

    def test_refuses_to_run_without_required_lockfiles(self):
        self.both(NPM, CLEAN, CLEAN)
        self.assertEqual(self.run_main(), 2)

    def test_base_checkout_nested_in_head_is_not_scanned_as_head(self):
        self.base = os.path.join(self.head, "base")
        self.both(NPM, CLEAN, VULN)  # vulnerable only in base: removing a finding must pass
        self.assertEqual(self.run_main(NPM), 0)
        self.assertEqual(dr.discover(self.head, skip=[self.base]), [NPM])

    def test_discover_matches_known_lockfiles_and_skips_vendored_dirs(self):
        for rel in ("a/package-lock.json", "b/pylock.toml", "b/pylock.extra.toml", "c/requirements.txt",
                    "c/requirements-dev.txt", "node_modules/x/package-lock.json", "d/package.json",
                    "e/notes.txt"):
            self.lock(self.head, rel, [])
        self.assertEqual(dr.discover(self.head), [
            "a/package-lock.json", "b/pylock.extra.toml", "b/pylock.toml",
            "c/requirements-dev.txt", "c/requirements.txt"])


if __name__ == "__main__":
    unittest.main()
