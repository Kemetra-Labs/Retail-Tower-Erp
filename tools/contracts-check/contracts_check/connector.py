"""Connector read-models against the in-tree contract YAML (RT-868 scope 1b).

The Connector's `contracts.py` modules live in a Frappe app, so they are parsed with `ast` and
never imported. Compared with `components/schemas` of the contract:

  enums     a mapped frozenset-of-str constant must equal the schema `enum` (or `const`)
  patterns  a mapped `re.compile` must be the schema `pattern`; `\\d` counts as `[0-9]` only
            under `re.ASCII` (JSON Schema patterns are ECMA-262, whose `\\d` is ASCII), and no
            other flag is allowed
  fields    for each class with `from_wire` / `to_wire`, named like its schema:
              - every field it reads or emits must be a schema property
              - a field it reads by bare subscript (no `.get` of the same field in that
                `from_wire`) is one it cannot do without, so the schema must require it
              - every schema-required field must be emitted by `to_wire`
  version   the first `x.y.z[-tag]` in the module docstring against `info.version`: drift only

Unmapped module-level frozenset-of-str or `re.compile` constants fail, so a new wire constant
has to be classified (enum, pattern or local) before the check passes."""

import ast
import pathlib
import re

import yaml

from .findings import DRIFT, FAIL, OK, Finding

_VERSION = re.compile(r"\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)")
_SCHEMA_REF = "#/components/schemas/"
_MAX_HELPER_DEPTH = 4


class ModelError(ValueError):
    pass


# ---------------------------------------------------------------- module model


def _str_set(node):
    """The literal string set of `frozenset({...})` / `frozenset([...])`, else None."""
    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "frozenset"
            and len(node.args) == 1 and not node.keywords):
        return None
    arg = node.args[0]
    if not isinstance(arg, (ast.Set, ast.List, ast.Tuple)):
        return None
    if not all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in arg.elts):
        return None
    return frozenset(e.value for e in arg.elts)


def _is_frozenset_call(node):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "frozenset"


def _is_re_compile(node):
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "compile"
            and isinstance(node.func.value, ast.Name) and node.func.value.id == "re")


def _flag_names(node):
    """`re.ASCII | re.I` -> {"ASCII", "I"}; None when not a plain flag expression."""
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "re":
        return {node.attr}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, right = _flag_names(node.left), _flag_names(node.right)
        return None if left is None or right is None else left | right
    return None


def _regex(node):
    """(pattern, flags) of a literal `re.compile`, else None."""
    args = list(node.args) + [k.value for k in node.keywords if k.arg in ("pattern", "flags")]
    if not args or not (isinstance(args[0], ast.Constant) and isinstance(args[0].value, str)):
        return None
    flags = set()
    for extra in args[1:]:
        names = _flag_names(extra)
        if names is None:
            return None
        flags |= names
    return args[0].value, frozenset(flags)


def _module_assignments(tree):
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            yield stmt.targets[0].id, stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
            yield stmt.target.id, stmt.value


class Module:
    def __init__(self, source):
        try:
            tree = ast.parse(source)
        except SyntaxError as exc:
            raise ModelError(f"not parseable: {exc}") from None
        self.docstring = ast.get_docstring(tree) or ""
        self.functions = {s.name: s for s in tree.body if isinstance(s, ast.FunctionDef)}
        self.classes = {s.name: s for s in tree.body if isinstance(s, ast.ClassDef)}
        self.enums, self.patterns, self.unresolved = {}, {}, {}
        for name, value in _module_assignments(tree):
            if _is_frozenset_call(value):
                strings = _str_set(value)
                if strings is not None and all(isinstance(e, ast.Constant) for e in value.args[0].elts):
                    self.enums[name] = strings
                else:
                    self.unresolved[name] = "frozenset is not a literal set of strings"
            elif _is_re_compile(value):
                rx = _regex(value)
                if rx is None:
                    self.unresolved[name] = "re.compile is not a literal pattern with re.* flags"
                else:
                    self.patterns[name] = rx

    @property
    def version(self):
        match = _VERSION.search(self.docstring)
        return match.group(1) if match else None

    def wire_classes(self):
        out = {}
        for name, cls in self.classes.items():
            methods = {s.name: s for s in cls.body if isinstance(s, ast.FunctionDef)}
            if "from_wire" in methods or "to_wire" in methods:
                out[name] = methods
        return out


# ---------------------------------------------------------------- field reads / writes


def _resolve(node, bound):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bound.get(node.id)
    return None


def _wire_name_outside_access(node, wire):
    """True when a wire name occurs in `node` other than as `wire[...]` or `wire.get(...)`:
    the assignment target then aliases the wire mapping (`w = _require_object(wire, ...)`)."""
    if isinstance(node, ast.Name):
        return node.id in wire
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in wire:
        return False
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name) and node.func.value.id in wire):
        return False
    return any(_wire_name_outside_access(child, wire) for child in ast.iter_child_nodes(node))


def _aliases(func, wire):
    wire = set(wire)
    changed = True
    while changed:
        changed = False
        for node in ast.walk(func):
            if isinstance(node, ast.Assign) and _wire_name_outside_access(node.value, wire):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id not in wire:
                        wire.add(target.id)
                        changed = True
    return wire


def _params(func):
    return [a.arg for a in func.args.posonlyargs + func.args.args]


def collect_reads(func, wire, module_functions, bound=None, top=True, depth=0, hard=None, soft=None,
                  unresolved=None):
    """(hard, soft, unresolved) for the wire mapping. Hard: bare `wire["x"]` in the top-level
    `from_wire`. Soft: `.get`, and any read inside a module helper the wire mapping is passed to
    (helpers are followed, with string arguments bound by position or keyword). Unresolved:
    reads whose key is not a literal or a bound argument, which cannot be compared."""
    bound = bound or {}
    hard = set() if hard is None else hard
    soft = set() if soft is None else soft
    unresolved = set() if unresolved is None else unresolved
    wire = _aliases(func, wire)
    for node in ast.walk(func):
        if (isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load)
                and isinstance(node.value, ast.Name) and node.value.id in wire):
            key = _resolve(node.slice, bound)
            if key is None:
                unresolved.add(f"{func.name}: {ast.unparse(node)}")
            else:
                (hard if top else soft).add(key)
        elif isinstance(node, ast.Call):
            fn = node.func
            if (isinstance(fn, ast.Attribute) and fn.attr == "get" and isinstance(fn.value, ast.Name)
                    and fn.value.id in wire and node.args):
                key = _resolve(node.args[0], bound)
                if key is None:
                    unresolved.add(f"{func.name}: {ast.unparse(node)}")
                else:
                    soft.add(key)
            elif (isinstance(fn, ast.Name) and fn.id in module_functions and depth < _MAX_HELPER_DEPTH):
                helper = module_functions[fn.id]
                params = _params(helper)
                pairs = list(zip(params, node.args)) + [(k.arg, k.value) for k in node.keywords if k.arg in params]
                passed = {p for p, a in pairs if isinstance(a, ast.Name) and a.id in wire}
                if passed:
                    sub_bound = {p: _resolve(a, bound) for p, a in pairs
                                 if p not in passed and _resolve(a, bound) is not None}
                    collect_reads(helper, passed, module_functions, sub_bound, False, depth + 1, hard, soft,
                                  unresolved)
    if top:
        hard -= soft
    return hard, soft, unresolved


def collect_writes(func):
    """Top-level keys of the mapping `to_wire` returns: a returned dict literal, or a name
    returned as the result whose dict literal and `name["k"] = ...` assignments add keys."""
    keys, returned = set(), set()
    for node in ast.walk(func):
        if isinstance(node, ast.Return) and node.value is not None:
            if isinstance(node.value, ast.Dict):
                keys |= _dict_keys(node.value)
            elif isinstance(node.value, ast.Name):
                returned.add(node.value.id)
    for node in ast.walk(func):
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        for target in targets:
            if isinstance(target, ast.Name) and target.id in returned and isinstance(value, ast.Dict):
                keys |= _dict_keys(value)
            elif (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                  and target.value.id in returned):
                key = _resolve(target.slice, {})
                if key is not None:
                    keys.add(key)
    return keys


def _dict_keys(node):
    return {k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}


# ---------------------------------------------------------------- schema side


def _follow(schemas, node, seen=()):
    if isinstance(node, dict) and isinstance(node.get("$ref"), str):
        ref = node["$ref"]
        if not ref.startswith(_SCHEMA_REF) or ref in seen:
            raise ModelError(f"unsupported or cyclic $ref {ref!r}")
        target = schemas.get(ref[len(_SCHEMA_REF):])
        if target is None:
            raise ModelError(f"dangling $ref {ref!r}")
        return _follow(schemas, target, seen + (ref,))
    return node


def schema_node(schemas, pointer):
    """`Name/properties/field` under components/schemas, following local $refs."""
    parts = pointer.split("/")
    node = schemas.get(parts[0])
    if node is None:
        raise ModelError(f"no schema {parts[0]!r}")
    node = _follow(schemas, node)
    for part in parts[1:]:
        if not isinstance(node, dict) or part not in node:
            raise ModelError(f"{pointer!r}: no {part!r}")
        node = _follow(schemas, node[part])
    return node


def object_shape(schemas, name):
    """(properties, required) of a schema, merging unconditional allOf members."""
    node = schema_node(schemas, name)
    props, required = set(node.get("properties") or {}), set(node.get("required") or [])
    for member in node.get("allOf") or []:
        member = _follow(schemas, member)
        if isinstance(member, dict) and not {"if", "then", "else", "not"} & set(member):
            props |= set(member.get("properties") or {})
            required |= set(member.get("required") or [])
    return props, required


def normalise_pattern(pattern, ascii_digits):
    """`\\d` -> `[0-9]` (`0-9` inside a class) when digits are ASCII-only; else unchanged."""
    if not ascii_digits:
        return pattern
    out, i, in_class = [], 0, False
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\" and i + 1 < len(pattern):
            pair = pattern[i:i + 2]
            out.append(("0-9" if in_class else "[0-9]") if pair == "\\d" else pair)
            i += 2
            continue
        if ch == "[" and not in_class:
            in_class = True
        elif ch == "]" and in_class:
            in_class = False
        out.append(ch)
        i += 1
    return "".join(out)


_UNICODE_CLASS = re.compile(r"(?<!\\)(?:\\\\)*\\[wWsSbB]")


def _canonical_end(pattern):
    """A trailing unescaped `\\Z` (Python's exact end of string) is the contract's ECMA `$`.

    Connector side only: in the contract (ECMA-262) `\\Z` is a literal "Z", not an anchor."""
    body = pattern[:-1]
    if pattern.endswith("Z") and (len(body) - len(body.rstrip("\\"))) % 2 == 1:
        return body[:-1] + "$"
    return pattern


def _ends_with_dollar(pattern):
    """An unescaped trailing `$` (an odd number of backslashes before it escapes it)."""
    if not pattern.endswith("$"):
        return False
    backslashes = len(pattern[:-1]) - len(pattern[:-1].rstrip("\\"))
    return backslashes % 2 == 0


def _fmt(values):
    return "{" + ", ".join(sorted(values)) + "}"


# ---------------------------------------------------------------- the check


def check_module(repo, entry, contracts_root):
    repo = pathlib.Path(repo)
    mod_path, contract = entry["module"], entry["contract"]
    tag = f"Connector {pathlib.PurePosixPath(contract).name}"
    try:
        module = Module((repo / mod_path).read_text(encoding="utf-8"))
        spec = yaml.safe_load((repo / contracts_root / contract).read_text(encoding="utf-8"))
        schemas = spec["components"]["schemas"]
        if not isinstance(schemas, dict):
            raise ModelError("components/schemas is not a mapping")
    except (OSError, UnicodeDecodeError, yaml.YAMLError, KeyError, TypeError, ModelError) as exc:
        return [Finding("connector", tag, FAIL, f"cannot read {mod_path} or {contract}: {exc}")]

    findings = []

    def add(subject, status, message):
        findings.append(Finding("connector", f"{tag} {subject}", status, message))

    enums, patterns = entry.get("enums") or {}, entry.get("patterns") or {}
    local = entry.get("local") or {}
    for name, why in sorted(module.unresolved.items()):
        add(name, FAIL, f"{why}; cannot compare")
    for name in sorted((set(module.enums) | set(module.patterns)) - set(enums) - set(patterns) - set(local)):
        add(name, FAIL, "module-level wire constant not classified in tools/contracts-check/config.yaml "
                        "(map it under enums/patterns, or list it under local with a reason)")

    for const, pointer in sorted(enums.items()):
        if const not in module.enums:
            add(const, FAIL, "mapped enum constant not found as a literal frozenset in the module")
            continue
        try:
            node = schema_node(schemas, pointer)
        except ModelError as exc:
            add(const, FAIL, f"schema {pointer}: {exc}")
            continue
        if "enum" in node:
            allowed = node["enum"]
        elif "const" in node:
            allowed = [node["const"]]
        else:
            add(const, FAIL, f"schema {pointer} has no enum or const")
            continue
        have, want = module.enums[const], frozenset(allowed)
        if have != want:
            detail = []
            if want - have:
                detail.append(f"contract only: {_fmt(want - have)}")
            if have - want:
                detail.append(f"connector only: {_fmt(have - want)}")
            add(const, FAIL, f"enum mismatch with {pointer}: " + "; ".join(detail))
        else:
            add(const, OK, f"= {pointer} {_fmt(have)}")

    for const, pointer in sorted(patterns.items()):
        if const not in module.patterns:
            add(const, FAIL, "mapped pattern constant not found as a literal re.compile in the module")
            continue
        try:
            node = schema_node(schemas, pointer)
        except ModelError as exc:
            add(const, FAIL, f"schema {pointer}: {exc}")
            continue
        want = node.get("pattern") if isinstance(node, dict) else None
        if not isinstance(want, str):
            add(const, FAIL, f"schema {pointer} has no pattern")
            continue
        pattern, flags = module.patterns[const]
        extra = sorted(flags - {"ASCII", "A"})
        if extra:
            add(const, FAIL, f"re flag(s) {extra} change the pattern's meaning against {pointer}")
            continue
        ascii_only = bool(flags & {"ASCII", "A"})
        if not ascii_only and _UNICODE_CLASS.search(pattern):
            add(const, FAIL, f"{pattern!r}: \\w/\\s/\\b without re.ASCII also match non-ASCII, unlike {pointer}")
            continue
        have = _canonical_end(normalise_pattern(pattern, ascii_only))
        if have != normalise_pattern(want, True):
            hint = " (\\d without re.ASCII also matches non-ASCII digits)" if "\\d" in have else ""
            add(const, FAIL, f"pattern mismatch with {pointer}: connector {pattern!r}, contract {want!r}{hint}")
        elif _ends_with_dollar(pattern):
            # Python `$` (with .match/.search) also matches before one trailing newline; ECMA `$`
            # does not. The connector then accepts "X\n" where the contract rejects it.
            add(const, DRIFT, f"= {pointer} {want!r}, but Python `$` also accepts a trailing newline "
                              "(use \\Z or fullmatch to match the contract exactly)")
        else:
            add(const, OK, f"= {pointer} {want!r}")

    for const in sorted(set(local) - set(module.enums) - set(module.patterns)):
        add(const, FAIL, "listed under local but not found in the module (stale config)")

    for cls, methods in sorted(module.wire_classes().items()):
        try:
            props, required = object_shape(schemas, cls)
        except ModelError as exc:
            add(cls, FAIL, f"class has from_wire/to_wire but no matching schema: {exc}")
            continue
        problems, counted = [], []
        if "from_wire" in methods:
            func = methods["from_wire"]
            params = _params(func)
            if len(params) < 2:
                add(cls, FAIL, "from_wire takes no wire argument")
                continue
            hard, soft, unresolved = collect_reads(func, {params[1]}, module.functions)
            reads = hard | soft
            if unresolved:
                problems.append(f"read(s) with a key that cannot be resolved: {_fmt(unresolved)}")
            if reads - props:
                problems.append(f"reads field(s) not in the contract: {_fmt(reads - props)}")
            if hard - required:
                problems.append(f"cannot parse without field(s) the contract marks optional: {_fmt(hard - required)}")
            counted.append(f"reads {len(reads)}")
        if "to_wire" in methods:
            emitted = collect_writes(methods["to_wire"])
            if emitted - props:
                problems.append(f"emits field(s) not in the contract: {_fmt(emitted - props)}")
            if required - emitted:
                problems.append(f"never emits required field(s): {_fmt(required - emitted)}")
            counted.append(f"emits {len(emitted)}")
        if problems:
            add(cls, FAIL, "; ".join(problems))
        else:
            add(cls, OK, f"fields consistent ({', '.join(counted)} of {len(props)} properties)")

    claimed, actual = module.version, (spec.get("info") or {}).get("version")
    if claimed != actual:
        add("version", DRIFT, f"module docstring cites {claimed or 'no version'}, contract info.version is {actual}")
    else:
        add("version", OK, f"{actual}")
    return findings
