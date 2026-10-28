"""Unit tests for toolchain_versions.py (RT-923, one Node and one Python per role). Stdlib only.

Each test builds a small repository in a temp directory: a passing baseline, then one violation of
each rule (a)-(d) on top of it, so every rule is shown to fail on its own.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toolchain_versions as tv  # noqa: E402

WORKFLOW = """jobs:
  test:
    steps:
      - uses: actions/setup-node@sha # v4.4.0
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-python@sha # v7.0.0
        with:
          python-version-file: connector/.python-version
"""


class ToolchainVersionsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        self.write(".nvmrc", "24\n")
        self.write(".python-version", "3.12\n")
        self.write(".github/workflows/ci.yml", WORKFLOW)
        self.write("svc/Dockerfile", "FROM node:24-bookworm-slim@sha256:abc AS base\nFROM base AS api\n")
        self.package("svc/package.json", engines=">=24", types="24.19.2")
        self.package("web/package.json", engines="^24.8.0 || >=25", types="^24.19.2")
        self.package("pos/package.json", engines=">=24", types="^24.19.2", electron="^44.5.1")
        self.write("connector/pyproject.toml", '[project]\nname = "c"\nrequires-python = ">=3.14"\n')
        self.write("connector/.python-version", "3.14\n")
        self.write("svc/node_modules/x/package.json", json.dumps({"engines": {"node": ">=8"}}))

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, path, text):
        full = os.path.join(self.repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as fh:
            fh.write(text)

    def package(self, path, engines=None, types=None, electron=None):
        pkg = {"name": path.split("/")[0], "devDependencies": {}}
        if engines is not None:
            pkg["engines"] = {"node": engines}
        if types is not None:
            pkg["devDependencies"]["@types/node"] = types
        if electron is not None:
            pkg["devDependencies"]["electron"] = electron
        self.write(path, json.dumps(pkg))

    def problems(self):
        return tv.check(self.repo)

    def assert_one(self, rule, fragment):
        problems = self.problems()
        self.assertEqual(len(problems), 1, problems)
        self.assertTrue(problems[0].startswith(f"({rule})"), problems)
        self.assertIn(fragment, problems[0])

    def test_baseline_passes_and_skips_node_modules(self):
        self.assertEqual(self.problems(), [])

    def test_a_inline_node_version(self):
        self.write(".github/workflows/ci.yml", WORKFLOW.replace("node-version-file: .nvmrc", 'node-version: "24"'))
        self.assert_one("a", "inline node-version")

    def test_a_inline_python_version(self):
        self.write(".github/workflows/x.yaml", "steps:\n  - with:\n      python-version: '3.12'\n")
        self.assert_one("a", "inline python-version")

    def test_a_missing_version_file(self):
        self.write(".github/workflows/ci.yml", WORKFLOW.replace("connector/.python-version", "nope/.python-version"))
        self.assert_one("a", "nope/.python-version does not exist")

    def test_b_dockerfile_node_major(self):
        self.write("svc/Dockerfile", "FROM node:22-bookworm-slim AS base\n")
        self.assert_one("b", "node:22-bookworm-slim")

    def test_b_dockerfile_without_major(self):
        self.write("svc/Dockerfile.dev", "FROM node:lts-slim\n")
        self.assert_one("b", "node:lts-slim")

    def test_a_flow_mapping_and_quoted_key(self):
        self.write(".github/workflows/x.yml", "steps:\n  - with: { node-version: 22 }\n")
        self.assert_one("a", "inline node-version")
        self.write(".github/workflows/x.yml", 'steps:\n  - with:\n      "python-version": "3.12"\n')
        self.assert_one("a", "inline python-version")

    def test_a_missing_version_file_in_flow_mapping_and_quoted_key(self):
        self.write(".github/workflows/x.yml", "steps:\n  - with: { node-version-file: nope/.nvmrc, cache: npm }\n")
        self.assert_one("a", "nope/.nvmrc does not exist")
        self.write(".github/workflows/x.yml", 'steps:\n  - with:\n      "python-version-file": "nope/.python-version"\n')
        self.assert_one("a", "nope/.python-version does not exist")
        self.write(".github/workflows/x.yml", "steps:\n  - with: { node-version-file: .nvmrc }\n")
        self.assertEqual(self.problems(), [])

    def test_b_registry_prefix_and_missing_tag(self):
        self.write("svc/Dockerfile", "FROM docker.io/library/node:22-slim AS base\n")
        self.assert_one("b", "node:22-slim")
        self.write("svc/Dockerfile", "FROM node AS base\n")
        self.assert_one("b", "node (no tag)")

    def test_b_workflow_and_compose_images(self):
        self.write(".github/workflows/svc.yml",
                   "jobs:\n  t:\n    container:\n      image: node:22-bookworm\n"
                   "    services:\n      r:\n        image: redis:7-alpine\n")
        self.assert_one("b", "image: node:22-bookworm")
        self.write(".github/workflows/svc.yml", "jobs: {}\n")
        self.write("svc/docker-compose.dev.yml",
                   "services:\n  app:\n    image: 'node:24-slim@sha256:abc'\n  db:\n    image: postgres:16\n")
        self.assertEqual(self.problems(), [])
        self.write("svc/docker-compose.dev.yml", "services:\n  app:\n    image: node:20\n")
        self.assert_one("b", "image: node:20")

    def test_b_other_images_are_ignored(self):
        self.write("svc/Dockerfile", "FROM node:24-slim AS base\nFROM nodered/node-red:3 AS x\nFROM nginx:1\n")
        self.assertEqual(self.problems(), [])

    def test_c_engines_lower_bound(self):
        self.package("svc/package.json", engines=">=22", types="24.19.2")
        self.assert_one("c", "engines.node '>=22'")

    def test_c_engines_any_alternative_below(self):
        self.package("web/package.json", engines="^22.22.3 || >=24.8.0", types="^24.19.2")
        self.assert_one("c", "engines.node")

    def test_c_types_node_major(self):
        self.package("web/package.json", engines=">=24", types="^22.10.2")
        self.assert_one("c", "@types/node '^22.10.2'")

    def test_c_electron_package_follows_electron(self):
        self.package("pos/package.json", engines=">=24", types="^20.19.39", electron="^44.5.1")
        self.assert_one("c", "(Electron 44)")

    def test_c_unknown_electron_major(self):
        self.package("pos/package.json", engines=">=24", types="^24.19.2", electron="^45.0.0")
        self.assert_one("c", "no ELECTRON_NODE_MAJOR entry")

    def test_d_requires_python_lower_bound(self):
        self.write("connector/pyproject.toml", '[project]\nname = "c"\nrequires-python = ">=3.10"\n')
        self.assert_one("d", "'>=3.10'")

    def test_d_python_version_file_changed(self):
        self.write("connector/.python-version", "3.15\n")
        self.assert_one("d", "is not 3.15")

    def test_unreadable_nvmrc_exits_2(self):
        self.write(".nvmrc", "lts/*\n")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(tv.main(["check", "--repo", self.repo]), 2)
        self.assertIn("unreadable input", out.getvalue())

    def test_main_exit_codes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tv.main(["check", "--repo", self.repo]), 0)
        self.package("svc/package.json", engines=">=22", types="24.19.2")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(tv.main(["check", "--repo", self.repo]), 1)
        self.assertIn("::error::toolchain versions (c)", out.getvalue())


if __name__ == "__main__":
    unittest.main()
