import ast
import json
import pathlib
import re
import tempfile
import unittest

import yaml

from contracts_check import pins
from contracts_check.findings import DRIFT, FAIL, OK

from support import REPO_ROOT, TempRepo, fake_oasdiff, real_oasdiff

SHA = "a" * 40
THIS_REPO = "Kemetra-Labs/Retail-Tower-Erp"
HEADER = f"repo: {THIS_REPO}\ncommit: {SHA}\nsource: contracts\n"
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


class ConsumerCase(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.bin = tempfile.TemporaryDirectory(prefix="cc-bin-")
        self.addCleanup(self.bin.cleanup)
        self.blob = self.repo.blob(SPEC)
        self.repo.write("contracts/pos-sales/sales.yaml", SPEC)

    def pin(self, blob=None, path="pos-sales/sales.yaml", header=HEADER):
        self.repo.write("app/PIN", f"{header}file: {path} {blob or self.blob}\n")

    def run_check(self, oasdiff, vendored=None):
        consumer = {"name": "POS", "pin": "app/PIN"}
        if vendored:
            consumer["vendored"] = vendored
        return pins.check_consumer(self.repo.root, consumer, "contracts", oasdiff, None,
                                   repository=THIS_REPO)

    def fake(self, **kw):
        return fake_oasdiff(self.bin.name, **kw)

    def test_identical_is_ok(self):
        self.pin()
        self.assertEqual([f.status for f in self.run_check(self.fake())], [OK])

    def test_foreign_repo_fails(self):
        """RT-889: a PIN that names another repository fails before anything is compared."""
        for repo in ("Kemetra/Backend-Core", "Kemetra-Labs/Retail-Tower-Erp-fork", "x/y"):
            with self.subTest(repo=repo):
                self.pin(header=HEADER.replace(f"repo: {THIS_REPO}", f"repo: {repo}"))
                [f] = self.run_check(self.fake())
                self.assertEqual(f.status, FAIL)
                self.assertIn(f"PIN names repo '{repo}', not this repository", f.message)

    def test_foreign_source_fails(self):
        self.pin(header=HEADER.replace("source: contracts", "source: packages/contracts/openapi"))
        [f] = self.run_check(self.fake())
        self.assertEqual(f.status, FAIL)
        self.assertIn("PIN names source 'packages/contracts/openapi'", f.message)

    def test_bad_or_missing_header_fails(self):
        for header in (HEADER.replace(SHA, "abc"), HEADER.replace(f"repo: {THIS_REPO}\n", ""),
                       HEADER.replace("source: contracts\n", ""), HEADER + f"repo: {THIS_REPO}\n"):
            with self.subTest(header=header):
                self.pin(header=header)
                [f] = self.run_check(self.fake())
                self.assertEqual(f.status, FAIL)

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


class RealPinHeaders(unittest.TestCase):
    """RT-889: config.yaml names this repository, and both real consumer PINs name it and the
    in-tree contract (no oasdiff needed)."""

    def test_config_names_this_repository(self):
        config = yaml.safe_load((REPO_ROOT / "tools/contracts-check/config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(config["repository"], THIS_REPO)
        for consumer in config["consumers"]:
            with self.subTest(consumer=consumer["name"]):
                header = pins.parse_header((REPO_ROOT / consumer["pin"]).read_text(encoding="utf-8"))
                self.assertIsNone(pins.check_header(header, THIS_REPO, config["contracts_root"]))


@unittest.skipUnless(real_oasdiff(), "set CONTRACTS_CHECK_OASDIFF to the pinned oasdiff binary")
class RealOasdiff(unittest.TestCase):
    """The acceptance cases against the real, pinned oasdiff (CI always sets it)."""

    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.repo.write("app/PIN", f"{HEADER}file: pos-sales/sales.yaml {self.repo.blob(SPEC)}\n")

    def run_with(self, current):
        self.repo.write("contracts/pos-sales/sales.yaml", current)
        return pins.check_consumer(self.repo.root, {"name": "POS", "pin": "app/PIN"}, "contracts",
                                   real_oasdiff(), None, repository=THIS_REPO)

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
class PinnedBlobProbes(unittest.TestCase):
    """RT-868 acceptance on the real POS pin of pos-sales/sales.yaml: removing a POS-used field
    fails, adding an optional field is drift. Base and revision both come from the pinned blob,
    so the result does not depend on the state of the working tree."""

    POS_SALES_BLOB = "b5371fc4cce168c43ef27c8e486e972c1e1b18ff"   # apps/pos/contracts/backend-core/PIN

    def setUp(self):
        data = pins.read_blob(REPO_ROOT, self.POS_SALES_BLOB)
        if data is None:
            self.fail(f"pinned blob {self.POS_SALES_BLOB} missing: run with full history (fetch-depth 0)")
        self.tmp = tempfile.TemporaryDirectory(prefix="cc-probe-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        (self.dir / "base.yaml").write_bytes(data)
        self.spec = yaml.safe_load(data)

    def check(self):
        revision = self.dir / "revision.yaml"
        revision.write_text(yaml.safe_dump(self.spec, sort_keys=False), encoding="utf-8")
        return pins.compare_file(real_oasdiff(), self.dir / "base.yaml", revision, None, "POS")

    def test_unchanged_is_ok(self):
        self.assertEqual([f.status for f in self.check()], [OK])

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


CONNECTOR_APP = REPO_ROOT / "integrations/erpnext-connector/retail_tower_erpnext_connector"
CONNECTOR = CONNECTOR_APP / "connector"
# Every Connector module that calls Backend-Core over HTTP (RT-704 inventory), relative to CONNECTOR.
CONNECTOR_TRANSPORTS = ("posting/transport.py", "bin_view/transport.py", "health/heartbeat.py")
# The one module allowed to import an HTTP library: `_RequestsTransport`, the HttpTransport the
# transports above call through `self._transport`. It takes the path as an argument and has no
# path of its own.
CONNECTOR_HTTP_ADAPTERS = ("posting/poller.py",)
_HTTP_VERBS = ("get", "post", "put", "patch", "delete", "request")
_HTTP_LIBRARIES = ("requests", "httpx", "urllib3", "aiohttp", "urllib.request", "http.client")
_TEMPLATE_PARAM = re.compile(r"\{[^}]*\}")


def _is_transport_call(node):
    """`<x>._transport.<verb>(...)`: the HttpTransport calls of the Connector clients."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr in _HTTP_VERBS and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == "_transport")


def _imports_http_library(node):
    """An import of an HTTP library in any form (`import requests as http`, `from requests import
    post`, `from urllib import request`): whatever the alias, the module can bypass the HttpTransport."""
    def is_http(name):
        return any(name == lib or name.startswith(lib + ".") for lib in _HTTP_LIBRARIES)
    if isinstance(node, ast.Import):
        return any(is_http(alias.name) for alias in node.names)
    if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
        return is_http(node.module) or any(is_http(f"{node.module}.{alias.name}") for alias in node.names)
    return False


def _api_paths(tree):
    return {node.targets[0].id: node.value.value for node in tree.body
            if isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str) and node.value.value.startswith("/api/")}


def connector_http_modules():
    """`(talks_to_backend, imports_http_library)`: Connector modules (tests excluded) that hold a
    string containing `/api/` (a path or an absolute URL) or make an HttpTransport call, and
    modules that import an HTTP library."""
    talks, library = set(), set()
    for path in sorted(CONNECTOR_APP.rglob("*.py")):
        rel = path.relative_to(CONNECTOR_APP)
        if rel.parts[0] == "tests":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        nodes = list(ast.walk(tree))
        key = path.relative_to(CONNECTOR).as_posix() if CONNECTOR in path.parents else rel.as_posix()
        has_api_literal = any(isinstance(n, ast.Constant) and isinstance(n.value, str)
                              and "/api/" in n.value for n in nodes)
        if has_api_literal or any(_is_transport_call(n) for n in nodes):
            talks.add(key)
        if any(_imports_http_library(n) for n in nodes):
            library.add(key)
    return talks, library


def connector_calls():
    """`({(METHOD, path)}, [unresolved])` for every `<x>._transport.<verb>(...)` call in the
    Connector transports, read with `ast` (the modules live in a Frappe app, never imported).
    A call resolves when its target is a module-level `/api/` constant, optionally `.format(...)`ed;
    any other target is unresolved, so it cannot escape the check. Path parameters are normalised
    to `{}`: the Connector names them in snake_case."""
    calls, unresolved = set(), []
    for rel in CONNECTOR_TRANSPORTS:
        tree = ast.parse((CONNECTOR / rel).read_text(encoding="utf-8"))
        paths = _api_paths(tree)
        for node in ast.walk(tree):
            if not _is_transport_call(node):
                continue
            arg = node.args[0] if node.args else None
            if (isinstance(arg, ast.Call) and isinstance(arg.func, ast.Attribute)
                    and arg.func.attr == "format"):
                arg = arg.func.value
            if node.func.attr != "request" and isinstance(arg, ast.Name) and arg.id in paths:
                calls.add((node.func.attr.upper(), _TEMPLATE_PARAM.sub("{}", paths[arg.id])))
            else:
                unresolved.append(f"{rel}:{node.lineno} {ast.unparse(node.func)}(...)")
    return calls, unresolved


class ConnectorPin(unittest.TestCase):
    """RT-704: the Connector PIN covers what the Connector actually calls and what the
    `connector` check compares, so a Backend-Core break on any of it fails `pins`."""

    def setUp(self):
        self.config = yaml.safe_load((REPO_ROOT / "tools/contracts-check/config.yaml").read_text(encoding="utf-8"))
        [consumer] = [c for c in self.config["consumers"] if c["name"] == "ERPNext-Connector"]
        self.pinned = dict(pins.parse_pin((REPO_ROOT / consumer["pin"]).read_text(encoding="utf-8")))

    def test_connector_check_contracts_are_pinned(self):
        for entry in self.config["connector"]:
            with self.subTest(module=entry["module"]):
                self.assertIn(entry["contract"], self.pinned)

    def test_every_connector_call_is_in_a_pinned_contract(self):
        served = set()
        for path, blob in self.pinned.items():
            data = pins.read_blob(REPO_ROOT, blob)
            if data is None:
                self.fail(f"pinned blob {blob} ({path}) missing: run with full history (fetch-depth 0)")
            for route, item in (yaml.safe_load(data).get("paths") or {}).items():
                served |= {(method.upper(), _TEMPLATE_PARAM.sub("{}", route)) for method in item
                           if method in ("get", "post", "put", "patch", "delete")}
        calls, unresolved = connector_calls()
        self.assertEqual(unresolved, [], "HttpTransport call whose target is not a module-level /api/ constant")
        # The five calls of the RT-704 inventory: a transport rewrite that hides them fails here.
        self.assertGreaterEqual(len(calls), 5, calls)
        self.assertEqual(sorted(calls - served), [])

    def test_transport_inventory_is_complete(self):
        """A new module that talks to Backend-Core must join CONNECTOR_TRANSPORTS, and only the
        HttpTransport adapter may import an HTTP library."""
        talks, library = connector_http_modules()
        self.assertEqual(sorted(talks), sorted(CONNECTOR_TRANSPORTS))
        self.assertEqual(sorted(library), sorted(CONNECTOR_HTTP_ADAPTERS))


def connector_pinned_blob(path):
    """The blob the Connector PIN (from config.yaml) pins for `path`."""
    config = yaml.safe_load((REPO_ROOT / "tools/contracts-check/config.yaml").read_text(encoding="utf-8"))
    [consumer] = [c for c in config["consumers"] if c["name"] == "ERPNext-Connector"]
    return dict(pins.parse_pin((REPO_ROOT / consumer["pin"]).read_text(encoding="utf-8")))[path]


@unittest.skipUnless(real_oasdiff(), "set CONTRACTS_CHECK_OASDIFF to the pinned oasdiff binary")
class ConnectorPinnedBlobProbe(unittest.TestCase):
    """RT-704 acceptance on the real Connector pin of erpnext-connector/posting-feed.yaml (read
    from the PIN, so a repin moves the probe with it): removing a field the Connector reads from
    a work item fails."""

    def setUp(self):
        blob = connector_pinned_blob("erpnext-connector/posting-feed.yaml")
        data = pins.read_blob(REPO_ROOT, blob)
        if data is None:
            self.fail(f"pinned blob {blob} missing: run with full history (fetch-depth 0)")
        self.tmp = tempfile.TemporaryDirectory(prefix="cc-probe-")
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        (self.dir / "base.yaml").write_bytes(data)
        self.spec = yaml.safe_load(data)

    def check(self):
        revision = self.dir / "revision.yaml"
        revision.write_text(yaml.safe_dump(self.spec, sort_keys=False), encoding="utf-8")
        return pins.compare_file(real_oasdiff(), self.dir / "base.yaml", revision, None, "ERPNext-Connector")

    def test_unchanged_is_ok(self):
        self.assertEqual([f.status for f in self.check()], [OK])

    def test_removing_payload_hash_fails(self):
        item = self.spec["components"]["schemas"]["PostingWorkItem"]
        del item["properties"]["payloadHash"]
        item["required"].remove("payloadHash")
        [f] = self.check()
        self.assertEqual(f.status, FAIL)
        self.assertIn("payloadHash", f.message)


if __name__ == "__main__":
    unittest.main()
