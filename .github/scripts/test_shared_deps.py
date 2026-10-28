"""Unit tests for shared_deps.py (RT-924, one version per shared library). Stdlib plus PyYAML.

Each test builds a small repository in a temp directory: a passing baseline, then one change on top.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shared_deps as sd  # noqa: E402

POLICY = """version: 1
libraries:
  react: 19.2.5
  vite: 8.3.4
  "@types/node": 24.19.2
exceptions: []
"""


class SharedDepsTests(unittest.TestCase):
    def setUp(self):
        # The tests run inside boundary-check, where GITHUB_STEP_SUMMARY is the real job summary:
        # keep fixture findings out of it, and restore the environment afterwards.
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("GITHUB_STEP_SUMMARY", None)
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        self.write("tools/versions/shared-deps.yaml", POLICY)
        self.package("apps/web/package.json", dependencies={"react": "^19.2.5"}, devDependencies={"vite": "~8.3.4"})
        self.package("apps/pos/package.json", dependencies={"react": "19.2.5"}, devDependencies={"@types/node": "^24.19.2"})
        self.package("services/api/package.json", devDependencies={"@types/node": "24.19.2"})
        self.package("services/api/packages/db/package.json", devDependencies={"@types/node": "24.19.2"})

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, path, text):
        full = os.path.join(self.repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as fh:
            fh.write(text)

    def package(self, path, **sections):
        self.write(path, json.dumps({"name": path.replace("/", "-"), **sections}))

    def findings(self):
        return sd.check(self.repo)

    def run_main(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = sd.main(["check", "--repo", self.repo, *extra])
        return code, out.getvalue()

    def test_baseline_ok_across_operators_and_nested_packages(self):
        self.assertEqual(self.findings(), [])
        self.assertEqual(self.run_main()[0], 0)

    def test_drift_is_reported_with_the_path_and_both_versions(self):
        self.package("apps/web/package.json", dependencies={"react": "^19.0.0"}, devDependencies={"vite": "~8.3.4"})
        self.assertEqual(self.findings(), ["(drift) apps/web/package.json: react is 19.0.0, policy 19.2.5"])

    def test_drift_in_a_nested_package_of_the_same_product(self):
        self.package("services/api/packages/db/package.json", devDependencies={"@types/node": "22.10.2"})
        self.assertEqual(len(self.findings()), 1)
        self.assertIn("services/api/packages/db/package.json", self.findings()[0])

    def test_not_a_plain_version_is_drift(self):
        self.package("apps/web/package.json", dependencies={"react": ">=19"}, devDependencies={"vite": "latest"})
        findings = self.findings()
        self.assertEqual(len(findings), 2)
        self.assertTrue(all("not a plain version" in f for f in findings))

    def test_report_mode_warns_and_passes_enforce_mode_fails(self):
        self.package("apps/web/package.json", dependencies={"react": "^18.3.1"}, devDependencies={"vite": "8.3.4"})
        code, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("::warning::shared deps (drift)", out)
        self.assertIn("report mode", out)
        code, out = self.run_main("--mode", "enforce")
        self.assertEqual(code, 1)
        self.assertIn("::error::shared deps (drift)", out)

    def test_exception_by_library_and_path_prefix(self):
        self.write("tools/versions/shared-deps.yaml", POLICY.replace("exceptions: []", """exceptions:
  - library: react
    path: apps/web/
    reason: embeds a React 18 host
    ticket: RT-1
"""))
        self.package("apps/web/package.json", dependencies={"react": "^18.3.1"}, devDependencies={"vite": "8.3.4"})
        self.assertEqual(self.findings(), [])

    def test_stale_exception_is_reported(self):
        self.write("tools/versions/shared-deps.yaml", POLICY.replace("exceptions: []", """exceptions:
  - library: react
    path: apps/gone/
    reason: x
    ticket: RT-1
"""))
        self.assertEqual(self.findings(), ["(policy) exception for react at apps/gone/ matches no declaration"])

    def test_listed_library_declared_nowhere(self):
        self.write("tools/versions/shared-deps.yaml", POLICY.replace("exceptions: []", "exceptions: []").replace(
            "  vite: 8.3.4\n", "  vite: 8.3.4\n  left-pad: 1.3.0\n"))
        self.assertEqual(self.findings(), ["(policy) left-pad is listed but no package.json declares it"])

    def test_unlisted_library_that_differs_across_products(self):
        self.package("apps/web/package.json", dependencies={"react": "^19.2.5", "zod": "^3.23.0"}, devDependencies={"vite": "8.3.4"})
        self.package("apps/pos/package.json", dependencies={"react": "19.2.5", "zod": "^4.0.0"}, devDependencies={"@types/node": "24.19.2"})
        findings = self.findings()
        self.assertEqual(len(findings), 1)
        self.assertTrue(findings[0].startswith("(unlisted) zod differs across products"))
        self.assertIn("apps/pos: 4.0.0", findings[0])

    def test_unlisted_library_with_one_version_or_one_product_is_silent(self):
        self.package("apps/web/package.json", dependencies={"react": "^19.2.5", "zod": "^3.23.0", "solo": "1.0.0"}, devDependencies={"vite": "8.3.4"})
        self.package("apps/pos/package.json", dependencies={"react": "19.2.5", "zod": "~3.23.0"}, devDependencies={"@types/node": "24.19.2"})
        self.package("services/api/packages/db/package.json", devDependencies={"@types/node": "24.19.2", "solo": "1.0.0"})
        self.assertEqual(self.findings(), [])

    def test_unlisted_library_differing_only_inside_one_product_is_silent(self):
        self.package("services/api/package.json", devDependencies={"@types/node": "24.19.2", "solo": "1.0.0"})
        self.package("services/api/packages/db/package.json", devDependencies={"@types/node": "24.19.2", "solo": "2.0.0"})
        self.assertEqual(self.findings(), [])

    def test_peer_dependencies_and_local_packages_are_ignored(self):
        self.package("apps/web/package.json", dependencies={"react": "^19.2.5", "@acme/shared": "workspace:*", "tool": "file:../x"},
                     devDependencies={"vite": "8.3.4"}, peerDependencies={"react": "^18 || ^19"})
        self.assertEqual(self.findings(), [])

    def test_node_modules_is_skipped(self):
        self.package("apps/web/node_modules/react/package.json", dependencies={"react": "1.0.0"})
        self.assertEqual(self.findings(), [])

    def test_product_of(self):
        self.assertEqual(sd.product_of("apps/admin-console/cloud-e2e/package.json"), "apps/admin-console")
        self.assertEqual(sd.product_of("services/backend-core/package.json"), "services/backend-core")
        self.assertEqual(sd.product_of("package.json"), "package.json")

    def test_broken_policy_exits_2_in_both_modes(self):
        for bad in ("version: 2\nlibraries: {a: 1.0.0}\n", "version: 1\nlibraries: {}\n",
                    "version: 1\nlibraries: {react: 19.2}\n", "version: 1\nlibraries: {react: 19.2.5}\nexceptions:\n  - library: react\n",
                    "version: 1\nlibraries: {react: 19.2.5}\nexceptions:\n  - {library: vite, path: a, reason: b, ticket: c}\n",
                    "libraries: [\n"):
            self.write("tools/versions/shared-deps.yaml", bad)
            for mode in ("report", "enforce"):
                code, out = self.run_main("--mode", mode)
                self.assertEqual(code, 2, (bad, mode, out))
                self.assertIn("unreadable input", out)

    def test_unquoted_version_that_yaml_reads_as_a_float_is_rejected(self):
        self.write("tools/versions/shared-deps.yaml", "version: 1\nlibraries:\n  react: 19.2\n")
        self.assertEqual(self.run_main()[0], 2)

    def test_duplicate_policy_key_exits_2(self):
        self.write("tools/versions/shared-deps.yaml", "version: 1\nlibraries:\n  react: 19.2.5\n  react: 19.0.0\n")
        code, out = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("duplicate key 'react'", out)

    def test_pre_release_policy_version_is_rejected(self):
        self.write("tools/versions/shared-deps.yaml", "version: 1\nlibraries:\n  react: 19.2.5-rc.1\n")
        self.assertEqual(self.run_main()[0], 2)

    def test_pre_release_declaration_is_drift_against_a_release(self):
        self.package("apps/web/package.json", dependencies={"react": "^19.2.5-rc.1"}, devDependencies={"vite": "8.3.4"})
        self.assertEqual(self.findings(), ["(drift) apps/web/package.json: react is 19.2.5-rc.1, policy 19.2.5"])

    def test_exception_path_needs_a_directory_or_file_anchor(self):
        self.write("tools/versions/shared-deps.yaml", POLICY.replace("exceptions: []", """exceptions:
  - library: react
    path: apps/web
    reason: x
    ticket: RT-1
"""))
        self.assertEqual(self.run_main()[0], 2)

    def test_exception_does_not_cover_a_sibling_with_the_same_prefix(self):
        self.write("tools/versions/shared-deps.yaml", POLICY.replace("exceptions: []", """exceptions:
  - library: react
    path: apps/web/
    reason: x
    ticket: RT-1
"""))
        self.package("apps/web/package.json", dependencies={"react": "18.3.1"}, devDependencies={"vite": "8.3.4"})
        self.package("apps/web-admin/package.json", dependencies={"react": "18.3.1"})
        findings = self.findings()
        self.assertEqual(len(findings), 1)
        self.assertIn("apps/web-admin/package.json", findings[0])

    def test_dependencies_that_are_not_an_object_exit_2(self):
        self.write("apps/web/package.json", json.dumps({"dependencies": ["react"]}))
        code, out = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("`dependencies` must be an object", out)

    def test_package_json_that_is_not_an_object_exits_2(self):
        for body in ("null", "[]", '"react"', "1"):
            self.write("apps/web/package.json", body)
            code, out = self.run_main()
            self.assertEqual(code, 2, body)
            self.assertIn("the top level must be an object", out)

    def test_findings_go_to_the_job_summary(self):
        self.package("apps/web/package.json", dependencies={"react": "^18.3.1"}, devDependencies={"vite": "8.3.4"})
        summary = os.path.join(self.repo, "summary.md")
        os.environ["GITHUB_STEP_SUMMARY"] = summary
        self.run_main()
        with open(summary, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("report mode): 1 finding(s)", text)
        self.assertIn("react is 18.3.1, policy 19.2.5", text)

    def test_malformed_package_json_exits_2(self):
        self.write("apps/web/package.json", "{")
        self.assertEqual(self.run_main()[0], 2)


if __name__ == "__main__":
    unittest.main()
