import json
import pathlib
import tempfile
import unittest

import yaml

from contracts_check import pins
from contracts_check.findings import DRIFT, FAIL, OK

from support import REPO_ROOT, TempRepo, fake_oasdiff, real_oasdiff

SHA = "a" * 40
SPEC = """\
openapi: 3.1.0
info: {title: t, version: 1.0.0}
paths:
  /sales/{ref}:
    get:
      operationId: getSale
      parameters:
        - {name: ref, in: path, required: true, schema: {type: string}}
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [saleRef, total]
                properties:
                  saleRef: {type: string}
                  total: {type: string}
"""


class ParsePin(unittest.TestCase):
    def test_reads_files_in_order(self):
        text = f"# c\nrepo: x/y\ncommit: {SHA}\nsource: p\n\nfile: a.yaml {SHA}\nfile: d/b.yaml {'b' * 40}\n"
        self.assertEqual(pins.parse_pin(text), [("a.yaml", SHA), ("d/b.yaml", "b" * 40)])

    def test_rejects(self):
        for text in (
            "repo: x\n",                                # no file lines
            f"file: a.yaml {SHA}\nfile: a.yaml {SHA}\n",  # duplicate
            "file: a.yaml abc\n",                       # short sha
            f"file: a.yaml {SHA.upper()}\n",            # not lowercase hex
            f"file: /abs.yaml {SHA}\n",
            f"file: ../up.yaml {SHA}\n",
            f"file: a.json {SHA}\n",
            f"file: a.yaml {SHA} extra\n",
            f"weird: a.yaml {SHA}\n",
            f"file a.yaml {SHA}\n",
        ):
            with self.subTest(text=text), self.assertRaises(pins.PinError):
                pins.parse_pin(text)

    def test_real_pins_parse(self):
        for pin in ("apps/pos/contracts/backend-core/PIN", "apps/admin-console/contracts/backend-core/PIN"):
            self.assertTrue(pins.parse_pin((REPO_ROOT / pin).read_text(encoding="utf-8")))


class ConsumerCase(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.bin = tempfile.TemporaryDirectory(prefix="cc-bin-")
        self.addCleanup(self.bin.cleanup)
        self.blob = self.repo.blob(SPEC)
        self.repo.write("contracts/pos-sales/sales.yaml", SPEC)

    def pin(self, blob=None, path="pos-sales/sales.yaml"):
        self.repo.write("app/PIN", f"repo: x/y\nfile: {path} {blob or self.blob}\n")

    def run_check(self, oasdiff, vendored=None):
        consumer = {"name": "POS", "pin": "app/PIN"}
        if vendored:
            consumer["vendored"] = vendored
        return pins.check_consumer(self.repo.root, consumer, "contracts", oasdiff, None)

    def fake(self, **kw):
        return fake_oasdiff(self.bin.name, **kw)

    def test_identical_is_ok(self):
        self.pin()
        self.assertEqual([f.status for f in self.run_check(self.fake())], [OK])

    def test_missing_blob_fails_closed(self):
        self.pin(blob="0" * 40)
        [f] = self.run_check(self.fake())
        self.assertEqual(f.status, FAIL)
        self.assertIn("not in this repository's object store", f.message)

    def test_unreadable_pin_fails(self):
        self.repo.write("app/PIN", "garbage\n")
        [f] = self.run_check(self.fake())
        self.assertEqual(f.status, FAIL)

    def test_missing_pin_file_fails(self):
        [f] = self.run_check(self.fake())
        self.assertEqual(f.status, FAIL)

    def test_pinned_file_removed_from_tree_fails(self):
        self.pin(path="gone.yaml")
        [f] = self.run_check(self.fake())
        self.assertEqual(f.status, FAIL)
        self.assertIn("no longer exists", f.message)

    def test_vendored_copy_must_hash_to_pin(self):
        self.pin()
        self.repo.write("app/openapi/pos-sales/sales.yaml", SPEC)
        self.assertEqual([f.status for f in self.run_check(self.fake(), vendored="app/openapi")], [OK])
        self.repo.write("app/openapi/pos-sales/sales.yaml", SPEC + "# edited\n")
        [f] = self.run_check(self.fake(), vendored="app/openapi")
        self.assertEqual(f.status, FAIL)
        self.assertIn("hashes to", f.message)

    def test_vendored_copy_missing_fails(self):
        self.pin()
        [f] = self.run_check(self.fake(), vendored="app/openapi")
        self.assertEqual(f.status, FAIL)

    def test_breaking_exit_fails(self):
        self.pin()
        out = json.dumps([{"id": "response-property-removed", "level": 2, "text": "removed"}])
        [f] = self.run_check(self.fake(breaking_exit=1, breaking_out=out))
        self.assertEqual(f.status, FAIL)
        self.assertIn("1 breaking change(s)", f.message)

    def test_breaking_exit_without_findings_still_fails(self):
        self.pin()
        [f] = self.run_check(self.fake(breaking_exit=1, breaking_out=""))
        self.assertEqual(f.status, FAIL)

    def test_warn_finding_with_exit_zero_still_fails(self):
        self.pin()
        out = json.dumps([{"id": "x", "level": 2, "text": "t"}])
        [f] = self.run_check(self.fake(breaking_out=out))
        self.assertEqual(f.status, FAIL)

    def test_tool_error_fails(self):
        self.pin()
        for kw in ({"breaking_exit": 102}, {"breaking_out": "{not json"}, {"changelog_exit": 1},
                   {"changelog_out": "{}"}):
            with self.subTest(kw=kw):
                [f] = self.run_check(self.fake(**kw))
                self.assertEqual(f.status, FAIL)

    def test_every_drift_change_is_listed(self):
        self.pin()
        out = json.dumps([{"id": f"change-{i}", "level": 1, "text": f"t{i}"} for i in range(40)])
        [f] = self.run_check(self.fake(changelog_out=out))
        self.assertIn("change-39", f.message)

    def test_non_breaking_change_is_drift(self):
        self.pin()
        out = json.dumps([{"id": "response-optional-property-added", "level": 1, "text": "added"}])
        [f] = self.run_check(self.fake(changelog_out=out))
        self.assertEqual(f.status, DRIFT)
        self.assertIn("1 non-breaking change(s)", f.message)


@unittest.skipUnless(real_oasdiff(), "set CONTRACTS_CHECK_OASDIFF to the pinned oasdiff binary")
class RealOasdiff(unittest.TestCase):
    """The acceptance cases against the real, pinned oasdiff (CI always sets it)."""

    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.repo.write("app/PIN", f"file: pos-sales/sales.yaml {self.repo.blob(SPEC)}\n")

    def run_with(self, current):
        self.repo.write("contracts/pos-sales/sales.yaml", current)
        return pins.check_consumer(self.repo.root, {"name": "POS", "pin": "app/PIN"}, "contracts",
                                   real_oasdiff(), None)

    def test_unchanged_is_ok(self):
        self.assertEqual([f.status for f in self.run_with(SPEC)], [OK])

    def test_removed_response_field_fails(self):
        [f] = self.run_with(SPEC.replace("required: [saleRef, total]", "required: [total]")
                            .replace("                  saleRef: {type: string}\n", ""))
        self.assertEqual(f.status, FAIL)
        self.assertIn("saleRef", f.message)

    def test_additive_change_is_drift(self):
        [f] = self.run_with(SPEC + "                  note: {type: string}\n")
        self.assertEqual(f.status, DRIFT)
        self.assertIn("note", f.message)

    def test_external_ref_is_not_followed(self):
        spec = SPEC.replace("total: {type: string}", "total: {$ref: 'https://example.invalid/x.yaml'}")
        [f] = self.run_with(spec)
        self.assertEqual(f.status, FAIL)


@unittest.skipUnless(real_oasdiff(), "set CONTRACTS_CHECK_OASDIFF to the pinned oasdiff binary")
class RealTreeProbes(unittest.TestCase):
    """RT-868 acceptance on the real pinned blobs: a POS-used field removed from the in-tree
    pos-sales/sales.yaml fails; adding an optional field is drift only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cc-probe-")
        self.addCleanup(self.tmp.cleanup)
        self.contracts = pathlib.Path(self.tmp.name)
        source = REPO_ROOT / "services/backend-core/packages/contracts/openapi"
        self.spec = yaml.safe_load((source / "pos-sales/sales.yaml").read_text(encoding="utf-8"))

    def check(self):
        (self.contracts / "pos-sales").mkdir(exist_ok=True)
        (self.contracts / "pos-sales/sales.yaml").write_text(yaml.safe_dump(self.spec, sort_keys=False),
                                                             encoding="utf-8")
        files = pins.parse_pin((REPO_ROOT / "apps/pos/contracts/backend-core/PIN").read_text(encoding="utf-8"))
        blob = dict(files)["pos-sales/sales.yaml"]
        base = self.contracts / "base.yaml"
        base.write_bytes(pins.read_blob(REPO_ROOT, blob))
        return pins.compare_file(real_oasdiff(), base, self.contracts / "pos-sales/sales.yaml",
                                 REPO_ROOT / "services/backend-core/tools/oasdiff/severity-levels.txt", "POS")

    def test_removing_sale_ref_fails(self):
        sale = self.spec["components"]["schemas"]["Sale"]
        del sale["properties"]["saleRef"]
        sale["required"].remove("saleRef")
        [f] = self.check()
        self.assertEqual(f.status, FAIL)
        self.assertIn("saleRef", f.message)

    def test_additive_optional_field_is_drift(self):
        self.spec["components"]["schemas"]["Sale"]["properties"]["probeNote"] = {"type": "string"}
        [f] = self.check()
        self.assertEqual(f.status, DRIFT)
        self.assertIn("probeNote", f.message)


if __name__ == "__main__":
    unittest.main()
