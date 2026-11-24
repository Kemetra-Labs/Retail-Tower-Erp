"""AST helpers shared by the Connector checks (`connector.py` and `wire_facts.py`)."""

import ast

MAX_HELPER_DEPTH = 4


def resolve(node, bound):
    """A string literal, or the string a helper parameter is bound to; else None."""
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


def aliases(func, wire):
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


def params(func):
    return [a.arg for a in func.args.posonlyargs + func.args.args]
