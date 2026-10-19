"""Layer-1 product boundary check (RT-709 B.1).

Graph-driven and dependency-free: it takes an already-built `Graph` and the
file texts, and reports any reference from product X to a path outside X's
root that no declared `edges.via` entry covers. Known violations live in the
ratchet file `boundary-todo.yaml` (entries may only be removed)."""

import json
import os
import posixpath
import re

from .globs import compile_glob

RATCHET_PATH = "tools/project-graph/boundary-todo.yaml"
MAX_FILE_BYTES = 2 * 1024 * 1024

JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
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


def _is_config(name):
    return name.startswith(("tsconfig", "vite.config", "vitest.config", "vitest.workspace")) \
        or name == "pnpm-workspace.yaml"


def _is_ci_or_shell(rel, name):
    return name.endswith((".sh", ".bash", ".ps1")) or name == "Makefile" \
        or name.startswith("Dockerfile") \
        or ("/.github/" in "/" + rel and name.endswith((".yml", ".yaml")))


class _Scanner:
    def __init__(self, graph):
        self.graph = graph
        self.edges = [(e["from"], [compile_glob(g) for g in e["via"]]) for e in graph.data["edges"]]
        self.violations = []

    def _line(self, text, pos):
        return text.count("\n", 0, pos) + 1

    def _target_product(self, target):
        if target == ".." or target.startswith("../"):
            return "outside"
        for name, root in self.graph.roots.items():
            if target + "/" == root:        # the product root directory itself
                return name
        c = self.graph.classify(target)
        return c.owner if c.kind == "product" else "outside"

    def _allowed(self, product, target):
        return any(src == product and any(g.match(target) for g in via) for src, via in self.edges)

    def _report(self, rule, src, product, target, to_product, line):
        if to_product != product and not self._allowed(product, target):
            self.violations.append({"rule": rule, "from": src, "to": target,
                                    "to_product": to_product, "line": line})

    def _relative(self, rule, src, product, base_dir, spec, line):
        target = posixpath.normpath(posixpath.join(base_dir, spec))
        self._report(rule, src, product, target, self._target_product(target), line)

    def scan_file(self, path, text):
        c = self.graph.classify(path)
        if c.kind != "product":
            return
        product = c.owner
        root = self.graph.roots[product]
        rel = path[len(root):]
        name = posixpath.basename(path)
        base_dir = posixpath.dirname(path)
        if name.endswith(JS_EXT) and not _is_config(name):
            self._scan_js(path, product, base_dir, text)
        if _is_config(name):
            for m in STRING_LITERAL.finditer(text):
                self._relative("config-path", path, product, base_dir, m.group(1), self._line(text, m.start()))
        if name == "package.json":
            self._scan_manifest(path, product, base_dir, text)
        if name.endswith(".py"):
            self._scan_python(path, product, rel, text)
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
    each is a violation, so padding a file past the cap cannot hide it."""
    scanner = _Scanner(graph)
    for path in sorted(files):
        scanner.scan_file(path, files[path])
    for path in sorted(unscanned):
        if graph.classify(path).kind == "product":
            scanner.violations.append({"rule": "unscanned-file", "from": path, "to": path,
                                       "to_product": "unscanned", "line": 0})
    keys = {(r["rule"], r["from"], r["to"]) for r in ratchet}
    found = {(v["rule"], v["from"], v["to"]) for v in scanner.violations}
    return {
        "violations": [v for v in scanner.violations if (v["rule"], v["from"], v["to"]) not in keys],
        "ratcheted": [v for v in scanner.violations if (v["rule"], v["from"], v["to"]) in keys],
        "stale_ratchet": [r for r in ratchet if (r["rule"], r["from"], r["to"]) not in found],
    }


def _wanted(path):
    name = posixpath.basename(path)
    return name.endswith(JS_EXT + (".py",)) or name in ("package.json", "pyproject.toml") \
        or _is_config(name) or _is_ci_or_shell(path, name)


def read_worktree_files(repo, paths):
    """Return (files, unscanned). Symlinks are skipped: the evaluator already
    fails closed on any symlink not allow-listed in the trusted graph."""
    out, unscanned = {}, []
    for path in paths:
        if not _wanted(path):
            continue
        full = os.path.join(repo, *path.split("/"))
        try:
            if os.path.islink(full):
                continue
            if os.path.getsize(full) > MAX_FILE_BYTES:
                unscanned.append(path)
                continue
            with open(full, encoding="utf-8", errors="replace") as fh:
                out[path] = fh.read()
        except OSError:
            unscanned.append(path)
    return out, unscanned


def load_ratchet(repo):
    """Parsing the ratchet needs the strict YAML loader; `scan` itself does not."""
    from .graph import load_yaml_list
    full = os.path.join(repo, *RATCHET_PATH.split("/"))
    if not os.path.exists(full):
        return []
    with open(full, encoding="utf-8") as fh:
        return load_yaml_list(fh.read())
