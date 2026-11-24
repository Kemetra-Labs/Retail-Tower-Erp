"""What a Connector `from_wire` / `to_wire` assumes about each wire field (RT-1583, P1 to P3).

Read with `ast`, never imported. Three kinds of fact, each deliberately conservative: a fact is
recorded only when the code states it plainly, so a check built on them under-claims and never
over-claims (a field whose use cannot be read is simply not compared).

  kinds     the JSON types a field must be: a rejecting `if not isinstance(x, T): raise`, or
            `Model.from_wire(x)` (object), also through a module helper it is passed to.
            `str(x)` / `int(x)` / `float(x)` are conversions, not assertions: they only rule out
            an object or array (and a boolean for the numeric ones). For `to_wire`, the type of
            the value stored under each key.
  literals  an unconditional `if x != "lit": raise` / `if x not in ("a", "b"): raise`: the
            only values the Connector accepts for that field.
  rejects   fields the Connector refuses when absent: an unconditional top-level
            `if x is None: raise` (also `not x`, `"k" not in wire`, a literal or isinstance
            guard, which a missing field fails too). Anything nested in another branch,
            loop or `try` does not count, so an optional field read under a condition stays
            optional."""

import ast
from dataclasses import dataclass, field

from .astutil import MAX_HELPER_DEPTH, aliases, params, resolve

_ISINSTANCE_KINDS = {"str": "string", "int": "integer", "float": "number", "bool": "boolean", "list": "array",
                     "tuple": "array", "Sequence": "array", "dict": "object", "Mapping": "object"}
_COERCION_KINDS = {"str": "string", "int": "integer", "float": "number"}
# What a read-side conversion tolerates (it is not a type assertion), as a pseudo-kind.
_COERCES = {"str": "coerce:any-scalar", "int": "coerce:numeric", "float": "coerce:numeric"}


@dataclass
class Facts:
    kinds: dict = field(default_factory=dict)      # wire key -> {json type}
    literals: dict = field(default_factory=dict)   # wire key -> [accepted frozenset, ...]
    rejects: set = field(default_factory=set)      # wire keys refused when absent

    def kind(self, key, kind):
        self.kinds.setdefault(key, set()).add(kind)


def _name_of(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _type_kinds(node):
    """JSON types of an `isinstance` class argument, plus whether `None` is among the classes."""
    members = node.elts if isinstance(node, ast.Tuple) else [node]
    kinds, allows_none = set(), False
    for member in members:
        if isinstance(member, ast.Constant) and member.value is None:
            allows_none = True
        elif (isinstance(member, ast.Call) and _name_of(member.func) == "type" and len(member.args) == 1
              and isinstance(member.args[0], ast.Constant) and member.args[0].value is None):
            allows_none = True
        elif _name_of(member) in _ISINSTANCE_KINDS:
            kinds.add(_ISINSTANCE_KINDS[_name_of(member)])
    return kinds, allows_none


def _str_values(node):
    """The literal strings of a tuple / list / set / frozenset({...}) display, else None."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "frozenset" \
            and len(node.args) == 1:
        node = node.args[0]
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)) and node.elts \
            and all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.elts):
        return frozenset(e.value for e in node.elts)
    return None


class _Reader:
    """Resolves an expression to the wire key it reads, inside one function.

    A local name resolves to a key only when every binding of that name in the function reads the
    same key: a name that is re-bound (`v = w.get("a")` ... `v = w.get("b")`) is ambiguous and
    resolves to nothing, because the facts are not flow-sensitive."""

    def __init__(self, func, wire, bound, seed):
        self.func, self.wire, self.bound = func, aliases(func, wire), bound
        self.names, self.defaulted = {}, set()
        for _ in range(3):
            assigned = {name: [key] for name, key in seed.items()}
            defaults = {}
            for node in ast.walk(func):
                for name, value in self._bindings(node):
                    assigned.setdefault(name, []).append(None if value is None else self.key(value))
                    if value is not None and self._has_default(value):
                        defaults.setdefault(name, True)
            self.names = {n: ks[0] for n, ks in assigned.items() if ks[0] is not None and len(set(ks)) == 1}
            self.defaulted = {n for n in self.names if n in defaults}

    @staticmethod
    def _bindings(node):
        """(name, value expression, or None when the value is not one expression) for each binding."""
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    yield target.id, node.value
                else:
                    for sub in ast.walk(target):
                        if isinstance(sub, ast.Name):
                            yield sub.id, None
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
            yield node.target.id, (node.value if isinstance(node, ast.AnnAssign) else None)
        elif isinstance(node, (ast.For, ast.comprehension)):
            for sub in ast.walk(node.target):
                if isinstance(sub, ast.Name):
                    yield sub.id, None
        elif isinstance(node, ast.NamedExpr):
            yield node.target.id, None
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            for sub in ast.walk(node.optional_vars):
                if isinstance(sub, ast.Name):
                    yield sub.id, None

    @staticmethod
    def _has_default(node):
        """`wire.get(k, <default>)` with a default other than None: absence is legal there."""
        return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get"
                and len(node.args) > 1 and not (isinstance(node.args[1], ast.Constant) and node.args[1].value is None))

    def key(self, node):
        if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load) \
                and isinstance(node.value, ast.Name) and node.value.id in self.wire:
            return resolve(node.slice, self.bound)
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name) and node.func.value.id in self.wire and node.args):
            return resolve(node.args[0], self.bound)
        if isinstance(node, ast.Name):
            return self.names.get(node.id)
        return None

    def key_if_absent_is_refused(self, node):
        """Like `key`, but None when a default stands in for an absent field."""
        if self._has_default(node) or (isinstance(node, ast.Name) and node.id in self.defaulted):
            return None
        return self.key(node)

    def is_wire(self, node):
        return isinstance(node, ast.Name) and node.id in self.wire


def _raises(body):
    """A branch that always ends by raising (it may do other work first, but never returns)."""
    return bool(body) and isinstance(body[-1], ast.Raise) \
        and not any(isinstance(n, ast.Return) for s in body for n in ast.walk(s))


def _guard(test, reader):
    """(keys refused when absent, [(key, accepted literals)]) of an `if <test>: raise`."""
    absent, literals = set(), []
    if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.Or):
        for value in test.values:
            a, lit = _guard(value, reader)
            absent |= a
            literals += lit
        return absent, literals
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        operand = test.operand
        key = reader.key_if_absent_is_refused(operand)
        if key is not None:
            absent.add(key)
        elif isinstance(operand, ast.Call) and _name_of(operand.func) == "isinstance" and len(operand.args) == 2:
            key = reader.key_if_absent_is_refused(operand.args[0])
            if key is not None and not _type_kinds(operand.args[1])[1]:
                absent.add(key)
        return absent, literals
    if not (isinstance(test, ast.Compare) and len(test.ops) == 1):
        return absent, literals
    left, op, right = test.left, test.ops[0], test.comparators[0]
    if isinstance(op, (ast.Is, ast.Eq)) and isinstance(right, ast.Constant) and right.value is None:
        key = reader.key_if_absent_is_refused(left)
        if key is not None:
            absent.add(key)
    elif isinstance(op, ast.NotIn) and reader.is_wire(right) and isinstance(left, ast.Constant) \
            and isinstance(left.value, str):
        absent.add(left.value)
    elif isinstance(op, (ast.NotEq, ast.NotIn)):
        for subject, other in ((left, right), (right, left)) if isinstance(op, ast.NotEq) else ((left, right),):
            key = reader.key(subject)
            if key is None:
                continue
            refused = reader.key_if_absent_is_refused(subject)
            if isinstance(op, ast.NotEq) and isinstance(other, ast.Constant) and isinstance(other.value, str):
                accepted = frozenset({other.value})
            elif isinstance(op, ast.NotIn) and _str_values(other) is not None:
                accepted = _str_values(other)
            else:
                continue
            if refused is not None:
                absent.add(key)     # None is not any of these strings, so an absent field is refused
            literals.append((key, accepted))
    return absent, literals


def _unconditional(node):
    """Sub-expressions of a statement that always run: not an `if` branch, a right-hand operand,
    a comprehension element or a lambda body."""
    yield node
    if isinstance(node, ast.IfExp):
        children = [node.test]
    elif isinstance(node, ast.BoolOp):
        children = node.values[:1]
    elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
        children = [node.generators[0].iter]
    elif isinstance(node, ast.Lambda):
        children = []
    else:
        children = list(ast.iter_child_nodes(node))
    for child in children:
        yield from _unconditional(child)


def collect(func, wire, functions, classes, bound=None, seed=None, always=True, depth=0, facts=None):
    """Facts for `wire` in `func`. `always` is True while every call on the way here is made
    unconditionally from the top level of `from_wire`; only then are guards counted."""
    facts = Facts() if facts is None else facts
    reader = _Reader(func, wire, bound or {}, seed or {})
    in_raise = {id(n) for r in ast.walk(func) if isinstance(r, ast.Raise) for n in ast.walk(r)}

    for node in ast.walk(func):
        if isinstance(node, ast.If) and _raises(node.body):
            # Only a rejecting `if not isinstance(x, T): raise` states a type; a branch on
            # `isinstance` (`if isinstance(x, dict): x = x.get("id")`) is normalisation, not a claim.
            for neg in ast.walk(node.test):
                if (isinstance(neg, ast.UnaryOp) and isinstance(neg.op, ast.Not) and isinstance(neg.operand, ast.Call)
                        and _name_of(neg.operand.func) == "isinstance" and len(neg.operand.args) == 2):
                    key = reader.key(neg.operand.args[0])
                    if key is not None:
                        for kind in _type_kinds(neg.operand.args[1])[0]:
                            facts.kind(key, kind)
        if not isinstance(node, ast.Call) or id(node) in in_raise:
            continue
        name = _name_of(node.func)
        if isinstance(node.func, ast.Name) and name in _COERCES and len(node.args) == 1:
            key = reader.key(node.args[0])
            if key is not None:
                facts.kind(key, _COERCES[name])
        elif isinstance(node.func, ast.Attribute) and node.func.attr == "from_wire" \
                and _name_of(node.func.value) in classes and len(node.args) == 1:
            key = reader.key(node.args[0])
            if key is not None:
                facts.kind(key, "object")

    def follow(call, unconditional):
        if not (isinstance(call.func, ast.Name) and call.func.id in functions) or depth >= MAX_HELPER_DEPTH:
            return
        helper = functions[call.func.id]
        names = params(helper)
        pairs = list(zip(names, call.args)) + [(k.arg, k.value) for k in call.keywords if k.arg in names]
        passed = {p for p, a in pairs if reader.is_wire(a)}
        keys = {p: reader.key(a) for p, a in pairs if reader.key(a) is not None}
        if not passed and not keys:
            return
        sub_bound = {p: resolve(a, reader.bound) for p, a in pairs
                     if p not in passed and p not in keys and resolve(a, reader.bound) is not None}
        collect(helper, passed, functions, classes, sub_bound, keys, unconditional, depth + 1, facts)

    always_calls = set()
    if always:
        for stmt in func.body:
            if isinstance(stmt, ast.If) and _raises(stmt.body) and not stmt.orelse:
                absent, literals = _guard(stmt.test, reader)
                facts.rejects |= absent
                for key, accepted in literals:
                    facts.literals.setdefault(key, []).append(accepted)
            elif isinstance(stmt, ast.Return):
                # `return cls(a=_helper(wire, "k"))` runs its calls unconditionally, but nothing after it does.
                if stmt.value is not None:
                    always_calls |= {id(n) for n in _unconditional(stmt.value) if isinstance(n, ast.Call)}
                break
            elif isinstance(stmt, (ast.If, ast.For, ast.While, ast.Try, ast.With, ast.Raise)):
                # An early return, a loop or a `try` means the statements after it may not run for an
                # absent field (`if raw is None: return None` makes absence legal), so stop here.
                break
            else:
                always_calls |= {id(n) for n in _unconditional(stmt) if isinstance(n, ast.Call)}
    for node in ast.walk(func):
        if isinstance(node, ast.Call):
            follow(node, id(node) in always_calls)
    return facts


# ---------------------------------------------------------------- to_wire


def _value_kinds(node):
    """JSON types of an expression stored under a wire key, or None when unknown."""
    if isinstance(node, ast.Constant):
        v = node.value
        if isinstance(v, bool):
            return {"boolean"}
        if isinstance(v, str):
            return {"string"}
        if isinstance(v, int):
            return {"integer"}
        if isinstance(v, float):
            return {"number"}
        return None
    if isinstance(node, ast.JoinedStr):
        return {"string"}
    if isinstance(node, (ast.List, ast.Tuple, ast.ListComp, ast.GeneratorExp)):
        return {"array"}
    if isinstance(node, (ast.Dict, ast.DictComp)):
        return {"object"}
    if isinstance(node, ast.Call):
        name = _name_of(node.func)
        if isinstance(node.func, ast.Name) and name in _COERCION_KINDS:
            return {_COERCION_KINDS[name]}
        if isinstance(node.func, ast.Attribute) and node.func.attr == "to_wire":
            return {"object"}
        return None
    if isinstance(node, ast.IfExp):
        branches = [_value_kinds(node.body), _value_kinds(node.orelse)]
        known = [b for b in branches if b is not None]
        none_branch = [n for n in (node.body, node.orelse) if isinstance(n, ast.Constant) and n.value is None]
        if known and len(known) + len(none_branch) == 2:
            return set().union(*known)
    return None


def _dict_items(node):
    return [(k.value, v) for k, v in zip(node.keys, node.values)
            if isinstance(k, ast.Constant) and isinstance(k.value, str)]


def write_values(func):
    """key -> [value expressions] of the mapping `to_wire` returns: a returned dict literal, or a
    returned name whose dict literal and `name["k"] = ...` assignments add keys."""
    out, returned = {}, set()
    for node in ast.walk(func):
        if isinstance(node, ast.Return) and node.value is not None:
            if isinstance(node.value, ast.Dict):
                for key, value in _dict_items(node.value):
                    out.setdefault(key, []).append(value)
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
                for key, item in _dict_items(value):
                    out.setdefault(key, []).append(item)
            elif (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                  and target.value.id in returned):
                key = resolve(target.slice, {})
                if key is not None:
                    out.setdefault(key, []).append(value)
    return out


def written_kinds(func):
    """key -> {json type} for the values `to_wire` stores that can be typed."""
    out = {}
    for key, values in write_values(func).items():
        for value in values:
            kinds = _value_kinds(value)
            if kinds:
                out.setdefault(key, set()).update(kinds)
    return out
