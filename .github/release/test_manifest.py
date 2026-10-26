"""Spec for .github/release/manifest.py (RT-871). Run: python -m unittest discover -s .github/release -v"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import manifest  # noqa: E402

# RT-889: consumer PINs name this repository and the in-tree Backend-Core contract.
PIN = ("repo: Kemetra-Labs/Retail-Tower-Erp\ncommit: {c}\n"
       "source: services/backend-core/packages/contracts/openapi\nfile: a.yaml 0123\n")


def sh(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout.strip()


class ManifestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        repo = cls.repo = os.path.join(cls.tmp.name, "repo")
        files = {
            "apps/pos/package.json": "{}\n",
            "apps/pos/contracts/backend-core/PIN": PIN.format(c="a" * 40),
            "apps/admin-console/contracts/backend-core/PIN": PIN.format(c="b" * 40),
            "services/backend-core/package.json": "{}\n",
            f"{manifest.CONTRACTS}/sales.yaml": "openapi: 3.1.0\n",
            f"{manifest.CONTRACTS}/erpnext-connector/feed.yaml": "x: 1\n",
            f"{manifest.CONTRACTS}/connector/view.yaml": "y: 1\n",
            "integrations/erpnext-connector/pyproject.toml": "[project]\n",
        }
        for rel, text in files.items():
            p = pathlib.Path(repo, rel)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        sh(cls.tmp.name, "init", "-q", repo)
        sh(repo, "add", ".")
        sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
        cls.sha = sh(repo, "rev-parse", "HEAD")
        cls.art = os.path.join(cls.tmp.name, "pkg.zip")
        pathlib.Path(cls.art).write_bytes(b"package")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_main(self, product, *extra, mode="dry-run"):
        out = tempfile.mkdtemp(dir=self.tmp.name)
        rc = manifest.main(["--product", product, "--sha", self.sha, "--mode", mode, "--repo", self.repo,
                            "--repository", "Kemetra/Retail-Tower-Shadow", "--ci-url", "https://github.com/x/actions/runs/1",
                            "--out", out, *extra])
        data = json.loads(pathlib.Path(out, "release-manifest.json").read_text()) if rc == 0 else None
        return rc, data, out

    def test_pos_dry_run_has_every_field(self):
        rc, m, out = self.run_main("pos", "--artifact", f"pos-win={self.art}")
        self.assertEqual(rc, 0)
        self.assertEqual(m["source"]["sha"], self.sha)
        self.assertEqual(m["source"]["product_tree"], sh(self.repo, "rev-parse", f"{self.sha}:apps/pos"))
        self.assertEqual(m["artifacts"][0]["digest"],
                         "sha256:" + __import__("hashlib").sha256(b"package").hexdigest())
        snap = m["contract_snapshot"]
        self.assertEqual(snap["backend_core_contract_tree"], sh(self.repo, "rev-parse", f"{self.sha}:{manifest.CONTRACTS}"))
        self.assertEqual(snap["consumer_pin"]["commit"], "a" * 40)
        self.assertEqual(snap["consumer_pin"]["repo"], "Kemetra-Labs/Retail-Tower-Erp")
        self.assertEqual(snap["consumer_pin"]["source"], manifest.CONTRACTS)
        self.assertEqual(m["ci_url"], "https://github.com/x/actions/runs/1")
        self.assertFalse(m["published"])
        sums = pathlib.Path(out, "SHA256SUMS").read_text()
        self.assertIn("release-manifest.json", sums)
        prov = json.loads(pathlib.Path(out, "provenance.intoto.json").read_text())
        self.assertFalse(prov["predicate"]["runDetails"]["metadata"]["signed"])

    def test_admin_pin_and_connector_semantic_trees(self):
        self.assertEqual(self.run_main("admin-console", "--artifact", f"dist={self.art}")[1]
                         ["contract_snapshot"]["consumer_pin"]["commit"], "b" * 40)
        snap = self.run_main("erpnext-connector", "--artifact", f"app={self.art}")[1]["contract_snapshot"]
        self.assertEqual(set(snap["semantic_contract_trees"]),
                         {f"{manifest.CONTRACTS}/erpnext-connector", f"{manifest.CONTRACTS}/connector"})

    def test_backend_core_records_compat_verdict_and_image_digest(self):
        d = "sha256:" + "c" * 64
        rc, m, _ = self.run_main("backend-core", "--artifact", f"api={self.art}", "--artifact-digest", f"api={d}",
                                 "--compat-verdict", "REFUSED", "--compat-evidence", "missing")
        self.assertEqual(rc, 0)
        self.assertEqual(m["compat_gate"], {"verdict": "REFUSED", "evidence": "missing"})
        self.assertEqual(m["artifacts"][0]["image_digest"], d)

    def test_refusals(self):
        art = ["--artifact", f"a={self.art}"]
        self.assertEqual(self.run_main("backend-core", *art)[0], 2)                      # no compat verdict
        self.assertEqual(self.run_main("backend-core", *art, "--compat-verdict", "REFUSED", "--tag", "backend-core/v1.0.0",
                                       mode="release")[0], 2)                            # MR-3: release needs PASS
        self.assertEqual(self.run_main("pos", *art, "--compat-verdict", "PASS")[0], 2)   # compat is BC only
        self.assertEqual(self.run_main("pos", *art, mode="release")[0], 2)               # release without tag
        self.assertEqual(self.run_main("pos", *art, "--tag", "admin-console/v1.0.0", mode="release")[0], 2)
        self.assertEqual(self.run_main("pos", *art, "--tag", "pos/v1.0.0")[0], 2)        # dry-run with a tag
        self.assertEqual(self.run_main("pos")[0], 2)                                     # no artifact
        self.assertEqual(self.run_main("pos", "--artifact-digest", "a=sha256:xyz")[0], 2)
        self.assertEqual(self.run_main("pos", "--artifact", "a=/nonexistent")[0], 2)
        self.assertEqual(self.run_main("nope", *art)[0], 2)

    def test_release_mode_with_tag(self):
        rc, m, _ = self.run_main("pos", "--artifact", f"a={self.art}", "--tag", "pos/v1.2.3", mode="release")
        self.assertEqual(rc, 0)
        self.assertEqual(m["tag"], "pos/v1.2.3")

    def test_missing_product_path_refuses(self):
        bare = os.path.join(self.tmp.name, "empty")
        sh(self.tmp.name, "init", "-q", bare)
        sh(bare, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "e")
        sha = sh(bare, "rev-parse", "HEAD")
        rc = manifest.main(["--product", "pos", "--sha", sha, "--mode", "dry-run", "--repo", bare, "--repository", "o/r",
                            "--ci-url", "https://x", "--artifact", f"a={self.art}", "--out", tempfile.mkdtemp(dir=self.tmp.name)])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
