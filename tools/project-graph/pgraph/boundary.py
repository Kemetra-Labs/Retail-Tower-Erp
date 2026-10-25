"""Layer-1 product boundary check (RT-709 B.1, hardened by RT-873).

Graph-driven and dependency-free: it takes an already-built `Graph` and the
file texts, and reports any reference from product X to a path outside X's
root that no declared `edges.via` entry covers. Known violations live in the
ratchet file `boundary-todo.yaml` (entries may only be removed: a stale entry
fails the check)."""

import json
import posixpath
import re

from .globs import compile_glob

RATCHET_PATH = "tools/project-graph/boundary-todo.yaml"
MAX_FILE_BYTES = 2 * 1024 * 1024

JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte")
JS_PATTERNS = [
    re.compile(r"""\bfrom\s+['"]([^'"\n]+)['"]"""),
    re.compile(r"""\bimport\s+['"]([^'"\n]+)['"]"""),
    re.compile(r"""\brequire\(\s*['"]([^'"\n]+)['"]\s*\)"""),
    re.compile(r"""\bimport\(\s*['"]([^'"\n]+)['"]\s*\)"""),
    re.compile(r"""///\s*<reference\s+path=['"]([^'"\n]+)['"]"""),
]
STRING_LITERAL = re.compile(r"""['"]((?:\.\.?/)[^'"\n]*)['"]""")
MANIFEST_DEP = re.compile(r"""['"](?:file|link|portal):([^'"\n]+)['"]""")
PY_SYS_PATH = re.compile(r"""sys\.path\.(?:insert|append)\([^)\n]*\.\.""")
PY_REL_IMPORT = re.compile(r"""^\s*from\s+(\.+)""", re.M)
PYPROJECT_PATH = re.compile(r"""\bpath\s*=\s*['"]([^'"\n]+)['"]""")
DOTDOT_TOKEN = re.compile(r"""(?<![\w.])((?:\.\./)+[\w.@/-]*)""")

# Path-shaped string literals outside import syntax (RT-873). A "run" is one
# literal, or several joined by `,` (path.join / resolve arguments) or, in
# Python, by `/` (pathlib). A run is a candidate only when a segment is `..`.
_SQ = r"""'(?:[^'\\\n]|\\.)*'"""
_DQ = r'''"(?:[^"\\\n]|\\.)*"'''
_BT = r"""`(?:\$\{[^}`\n]*\}/?)?[^`$\\\n]*`"""   # template literal: only a leading ${base}/
LITERAL = re.compile(f"{_SQ}|{_DQ}|{_BT}")
JS_LITERAL_RUN = re.compile(f"(?:{_SQ}|{_DQ}|{_BT})(?:\\s*,\\s*(?:{_SQ}|{_DQ}|{_BT}))*")
PY_LITERAL_RUN = re.compile(f"(?:{_SQ}|{_DQ})(?:\\s*[,/]\\s*(?:{_SQ}|{_DQ}))*")
PY_FILE_PARENTS = re.compile(
    r"""Path\(\s*__file__\s*\)(?:\.(?:resolve|absolute)\(\))?"""
    r"""(?P<climb>(?:\.parent\b)+|\.parents\[\s*(?P<n>\d+)\s*\])"""
    f"(?P<tail>(?:\\s*/\\s*(?:{_SQ}|{_DQ}))*)")
JSON_EXTENDS = re.compile(r'''"extends"\s*:\s*(\[[^\]]*\]|"[^"\n]*")''')

# POS and Admin-Console never call ERPNext/Frappe (MR-6). A literal counts as
# a Frappe REST route only when the WHOLE literal is the route: an optional
# scheme+host or leading ${...}, then /api/resource/<x> or /api/method/<x>,
# with no whitespace. UI copy and traversal test vectors do not match.
ERP_ROUTE = re.compile(r"""^(?:https?://[^/\s]+|\$\{[^}\s]*\})?/api/(?:resource|method)/[\w.%${}-]\S*$""")
EGRESS_ROOTS = ("apps/",)


def _is_config(name):
    return name.startswith(("tsconfig", "jsconfig", "vite.config", "vitest.config", "vitest.workspace",
                            "biome.json", ".eslintrc")) \
        or ".config." in name or name == "pnpm-workspace.yaml"


def _is_ci_or_shell(rel, name):
    return name.endswith((".sh", ".bash", ".ps1")) or name == "Makefile" \
        or name.startswith("Dockerfile") \
        or ("/.github/" in "/" + rel and name.endswith((".yml", ".yaml")))


def _literal_value(lit):
    body = lit[1:-1]
    if lit[0] == "`":
        body = re.sub(r"^\$\{[^}]*\}/?", "", body)
    return body


def _run_path(run):
    """Join a literal run into one relative path, or None unless it climbs."""
    parts = [_literal_value(m.group(0)) for m in LITERAL.finditer(run)]
    joined = "/".join(p.strip("/") if i else p.rstrip("/") for i, p in enumerate(parts))
    if not joined or joined.startswith("/") or "://" in joined or re.search(r"\s", joined):
        return None
    return joined if ".." in joined.split("/") else None


class _Scanner:
    def __init__(self, graph):
        self.graph = graph
        self.edges = [(e["from"], [compile_glob(g) for g in e["via"]]) for e in graph.data["edges"]]
        self.violations = []
        self._seen = set()      # (from, to, line): the first, most specific rule wins
        self._lines = set()     # (from, line) of python-sys-path hits, whose target is only ".."

    def _line(self, text, pos):
        return text.count("\n", 0, pos) + 1

    def _target_product(self, target):
        if target == ".." or target.startswith("../"):
            return "outside"
        for name, root in self.graph.roots.items():
            if target + "/" == root:        # the product root directory itself
                return name
        return self.graph.product_of(target) or "outside"

    def _allowed(self, product, target):
        return any(src == product and any(g.match(target) for g in via) for src, via in self.edges)

    def _report(self, rule, src, product, target, to_product, line):
        key = (src, target, line)
        if to_product != product and not self._allowed(product, target) and key not in self._seen:
            self._seen.add(key)
            if rule == "python-sys-path":
                self._lines.add((src, line))
            self.violations.append({"rule": rule, "from": src, "to": target,
                                    "to_product": to_product, "line": line})

    def _relative(self, rule, src, product, base_dir, spec, line):
        target = posixpath.normpath(posixpath.join(base_dir, spec))
        self._report(rule, src, product, target, self._target_product(target), line)

    def scan_file(self, path, text):
        product = self.graph.product_of(path)
        if product is None:
            return
        root = self.graph.roots[product]
        rel = path[len(root):]
        name = posixpath.basename(path)
        base_dir = posixpath.dirname(path)
        config = _is_config(name)
        if name.endswith(JS_EXT) and not config:
            self._scan_js(path, product, base_dir, text)
        if config:
            for m in STRING_LITERAL.finditer(text):
                self._relative("config-path", path, product, base_dir, m.group(1), self._line(text, m.start()))
        if name.endswith(JS_EXT):
            # import specifiers have a known base (the file's directory): never guess one for them
            specifiers = {m.start(1) - 1 for pattern in JS_PATTERNS for m in pattern.finditer(text)}
            self._scan_literals("config-path" if config else "path-literal", JS_LITERAL_RUN,
                                path, product, root, text, skip=specifiers)
        if name.endswith((".json", ".jsonc")):
            self._scan_json_extends(path, product, base_dir, text)
        if path.startswith(EGRESS_ROOTS) and name.endswith(JS_EXT):
            self._scan_egress(path, text)
        if name == "package.json":
            self._scan_manifest(path, product, base_dir, text)
        if name.endswith(".py"):
            self._scan_python(path, product, rel, text)
            self._scan_literals("python-path", PY_LITERAL_RUN, path, product, root, text)
        if name == "pyproject.toml":
            for m in PYPROJECT_PATH.finditer(text):
                self._relative("manifest-path", path, product, base_dir, m.group(1), self._line(text, m.start()))
        if _is_ci_or_shell(rel, name):
            self._scan_ci(path, product, base_dir, text)

    def _scan_js(self, path, product, base_dir, text):
        for pattern in JS_PATTERNS:
            for m in pattern.finditer(text):
                spec = m.group(1)
                if spec.startswith("."):
                    self._relative("import", path, product, base_dir, spec, self._line(text, m.start()))

    def _scan_literals(self, rule, pattern, path, product, root, text, skip=()):
        """A climbing literal's base is unknown (__dirname, cwd, a ROOT
        constant), so every directory from the file up to the product root is
        tried. The first base that reaches another product is reported;
        otherwise the literal is reported when it leaves the product even from
        the file's own (deepest) directory."""
        bases, d = [], posixpath.dirname(path)
        while d and d + "/" != root:
            bases.append(d)
            d = posixpath.dirname(d)
        bases.append(d)
        for m in pattern.finditer(text):
            spec = None if m.start() in skip else _run_path(m.group(0))
            if spec is None:
                continue
            targets = [posixpath.normpath(posixpath.join(b, spec)) for b in bases]
            hit = next((t for t in targets if self._target_product(t) not in (product, "outside")), None)
            if hit is None and self._target_product(targets[0]) != product:
                hit = targets[0]
            line = self._line(text, m.start())
            if hit is not None and (path, line) not in self._lines:   # sys.path already reported it
                self._report(rule, path, product, hit, self._target_product(hit), line)

    def _scan_json_extends(self, path, product, base_dir, text):
        for m in JSON_EXTENDS.finditer(text):
            for value in re.findall(r'"([^"\n]*)"', m.group(1)):
                if value.startswith("."):
                    self._relative("config-path", path, product, base_dir, value, self._line(text, m.start()))

    def _scan_egress(self, path, text):
        for m in LITERAL.finditer(text):
            value = m.group(0)[1:-1]
            if ERP_ROUTE.match(value):
                self.violations.append({"rule": "erp-egress", "from": path, "to": value,
                                        "to_product": "erpnext", "line": self._line(text, m.start())})

    def _scan_manifest(self, path, product, base_dir, text):
        for m in MANIFEST_DEP.finditer(text):
            self._relative("manifest-path", path, product, base_dir, m.group(1), self._line(text, m.start()))
        try:
            data = json.loads(text)
        except ValueError:
            return
        workspaces = data.get("workspaces") if isinstance(data, dict) else None
        for ws in workspaces if isinstance(workspaces, list) else []:
            if isinstance(ws, str) and ws.startswith(".."):
                self._relative("manifest-path", path, product, base_dir, ws, 1)

    def _scan_python(self, path, product, rel, text):
        for m in PY_SYS_PATH.finditer(text):
            self._report("python-sys-path", path, product, "..", "outside", self._line(text, m.start()))
        depth = rel.count("/")          # directories between product root and the file
        for m in PY_REL_IMPORT.finditer(text):
            if len(m.group(1)) - 1 > depth:  # n dots climb n-1 levels from the file's package
                self._report("python-relative-import", path, product, "..", "outside",
                             self._line(text, m.start()))
        for m in PY_FILE_PARENTS.finditer(text):
            # parents[n] climbs n levels above the file's directory; k x .parent climbs k-1
            up = int(m.group("n")) if m.group("n") else m.group("climb").count(".parent") - 1
            tail = [_literal_value(t.group(0)) for t in LITERAL.finditer(m.group("tail"))]
            spec = "/".join([".."] * up + tail) or "."
            self._relative("python-path", path, product, posixpath.dirname(path), spec,
                           self._line(text, m.start()))

    def _scan_ci(self, path, product, base_dir, text):
        for other, root in self.graph.roots.items():
            if other == product:
                continue
            for m in re.finditer(re.escape(root) + r"[\w.@/-]*", text):
                self._report("literal-product-path", path, product, m.group(0), other, self._line(text, m.start()))
        if posixpath.basename(path).startswith("Dockerfile"):
            return  # Dockerfile paths are relative to WORKDIR / build context, not the file
        for m in DOTDOT_TOKEN.finditer(text):
            self._relative("literal-escape", path, product, base_dir, m.group(1), self._line(text, m.start()))


def scan(graph, files, ratchet, unscanned=()):
    """files: {repo path: text}. ratchet: list of {rule, from, to, ticket}.
    unscanned: product paths that could not be read (oversize, I/O error);
    each is a violation, so padding a file past the cap cannot hide it.
    `ok` is False on any violation or any stale ratchet entry."""
    scanner = _Scanner(graph)
    for path in sorted(files):
        scanner.scan_file(path, files[path])
    for path in sorted(unscanned):
        if graph.product_of(path):
            scanner.violations.append({"rule": "unscanned-file", "from": path, "to": path,
                                       "to_product": "unscanned", "line": 0})
    keys = {(r["rule"], r["from"], r["to"]) for r in ratchet}
    found = {(v["rule"], v["from"], v["to"]) for v in scanner.violations}
    result = {
        "violations": [v for v in scanner.violations if (v["rule"], v["from"], v["to"]) not in keys],
        "ratcheted": [v for v in scanner.violations if (v["rule"], v["from"], v["to"]) in keys],
        "stale_ratchet": [r for r in ratchet if (r["rule"], r["from"], r["to"]) not in found],
    }
    result["ok"] = not (result["violations"] or result["stale_ratchet"])
    return result


def wanted(path):
    name = posixpath.basename(path)
    return name.endswith(JS_EXT + (".py", ".json", ".jsonc")) or name == "pyproject.toml" \
        or _is_config(name) or _is_ci_or_shell(path, name)


def read_rev_files(repo, rev):
    """Return (files, unscanned) for every wanted blob at `rev`, read through
    git plumbing (never the working tree). Symlinks are skipped: the evaluator
    already fails closed on any symlink not allow-listed in the trusted graph."""
    from .gitio import read_blobs
    return read_blobs(repo, rev, wanted, MAX_FILE_BYTES)


def load_ratchet(repo, rev="HEAD"):
    """The ratchet at `rev`. Parsing needs the strict YAML loader; `scan` does not."""
    from .gitio import read_text
    from .graph import load_yaml_list
    text = read_text(repo, rev, RATCHET_PATH)
    return load_yaml_list(text) if text else []
