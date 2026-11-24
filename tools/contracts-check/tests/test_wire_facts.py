"""RT-1583 P1 to P3: field types, inline literals and reject-when-absent of a Connector `from_wire`."""

import unittest

from contracts_check import connector, wire_facts
from contracts_check.findings import FAIL, OK

from support import TempRepo

SPEC = """\
openapi: 3.1.0
info: {title: t, version: 1.0.0}
paths: {}
components:
  schemas:
    Label: {type: string}
    Item:
      type: object
      required: [name]
      properties:
        name: {type: string}
        qty: {type: integer}
        note: {anyOf: [{type: string}, {type: 'null'}]}
        tags: {type: array, items: {type: string}}
        label: {$ref: '#/components/schemas/Label'}
    Pay:
      type: object
      required: [method]
      properties:
        method: {type: string, enum: [cash]}
        doctype: {const: Item}
"""

MODULE = '''\
class Item:
    @classmethod
    def from_wire(cls, wire):
        return cls(str(wire["name"]), wire.get("qty"), wire.get("note"), wire.get("tags"), wire.get("label"))
'''

ENTRY = {"module": "mod/contracts.py", "contract": "c/t.yaml", "enums": {}, "patterns": {}, "local": {}}


class Case(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)

    def run_check(self, module=MODULE, spec=SPEC):
        self.repo.write("mod/contracts.py", module)
        self.repo.write("contracts/c/t.yaml", spec)
        return connector.check_module(self.repo.root, ENTRY, "contracts")

    def cls(self, name, module=MODULE, spec=SPEC):
        hits = [f for f in self.run_check(module, spec) if f.subject.endswith(f" {name}")]
        self.assertEqual(len(hits), 1, hits)
        return hits[0]


class FieldTypes(Case):                                       # P1
    def test_baseline_passes(self):
        self.assertEqual(self.cls("Item").status, OK)

    def test_string_field_that_becomes_an_object_fails(self):
        spec = SPEC.replace("name: {type: string}", "name: {type: object, properties: {id: {type: string}}}")
        f = self.cls("Item", spec=spec)
        self.assertEqual(f.status, FAIL)
        self.assertIn("name (reads {a scalar via str()}, contract {object})", f.message)

    def test_isinstance_guard_is_a_type_fact(self):
        module = MODULE.replace('wire.get("qty")', '_qty(wire.get("qty"))') + '''
def _qty(raw):
    if not isinstance(raw, str):
        raise ValueError("qty")
    return raw
'''
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("qty (reads {string}, contract {integer})", f.message)

    def test_nested_from_wire_reads_an_object(self):
        module = MODULE.replace('wire.get("tags")', 'Item.from_wire(wire["tags"])')
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("tags (reads {object}, contract {array})", f.message)

    def test_type_is_followed_through_ref_and_nullable_union(self):
        module = MODULE.replace('wire.get("note")', 'str(wire.get("note"))').replace(
            'wire.get("label")', '_lbl(wire.get("label"))') + """
def _lbl(raw):
    if raw is not None and not isinstance(raw, int):
        raise ValueError("label")
    return raw
"""
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("label (reads {integer}, contract {string})", f.message)   # label is a $ref to a string
        self.assertNotIn("note", f.message)             # string is one of the anyOf members

    def test_conversions_are_not_type_claims(self):
        # str(x) accepts anything and int(x) accepts a numeric string: neither says what the field is.
        module = MODULE.replace('wire.get("qty")', 'str(wire.get("qty"))').replace(
            'wire.get("label")', 'int(wire.get("label"))')
        self.assertEqual(self.cls("Item", module=module).status, OK)
        number_string = SPEC.replace("qty: {type: integer}", "qty: {type: string, pattern: '^[0-9]+$'}")
        self.assertEqual(self.cls("Item", module=MODULE.replace('wire.get("qty")', 'float(wire.get("qty"))'),
                                  spec=number_string).status, OK)

    def test_a_conversion_still_rules_out_an_object(self):
        module = MODULE.replace('wire.get("qty")', 'int(wire.get("qty"))')
        spec = SPEC.replace("qty: {type: integer}", "qty: {type: object, properties: {n: {type: integer}}}")
        f = self.cls("Item", module=module, spec=spec)
        self.assertEqual(f.status, FAIL)
        self.assertIn("qty (reads {a number}, contract {object})", f.message)

    def test_isinstance_that_only_branches_is_not_a_type_claim(self):
        module = MODULE.replace('wire.get("label")', '_lbl(wire.get("label"))') + """
def _lbl(raw):
    if isinstance(raw, dict):
        raw = raw.get("id")
    if isinstance(raw, bool):
        return None
    return raw
"""
        self.assertEqual(self.cls("Item", module=module).status, OK)

    def test_a_rebound_name_is_not_attributed_to_either_key(self):
        module = MODULE.replace('return cls(', """v = wire.get("qty")
        if not isinstance(v, int):
            raise ValueError("q")
        v = wire.get("label")
        if v not in ("a", "b"):
            raise ValueError("l")
        return cls(""", 1)
        # qty (integer) and label (string): re-bound `v` must not turn into "label reads integer".
        self.assertEqual(self.cls("Item", module=module).status, OK)

    def test_the_same_name_bound_twice_to_the_same_key_still_counts(self):
        module = MODULE.replace('return cls(', """v = wire.get("qty")
        v = wire.get("qty")
        if not isinstance(v, str):
            raise ValueError("q")
        return cls(""", 1)
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("qty (reads {string}, contract {integer})", f.message)

    def test_integer_is_a_number_and_a_bool_guard_is_not_the_field_type(self):
        module = MODULE.replace('wire.get("qty")', '_qty(wire.get("qty"))') + '''
def _qty(raw):
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ValueError("qty")
    return raw
'''
        required = SPEC.replace("required: [name]", "required: [name, qty]")   # the guard refuses an absent qty
        self.assertEqual(self.cls("Item", module=module, spec=required).status, OK)
        number = required.replace("qty: {type: integer}", "qty: {type: number}")
        self.assertEqual(self.cls("Item", module=module, spec=number).status, OK)

    def test_unreadable_use_is_not_compared(self):
        module = MODULE.replace('wire.get("qty")', 'convert(wire.get("qty"))')
        self.assertEqual(self.cls("Item", module=module).status, OK)

    def test_error_message_text_is_not_a_type_fact(self):
        module = MODULE.replace('cls(', 'cls(_bad(wire.get("qty")), ') + '''
def _bad(raw):
    if raw == 0:
        raise ValueError("qty " + str(raw))
    return raw
'''
        self.assertEqual(self.cls("Item", module=module).status, OK)

    def test_to_wire_value_of_the_wrong_type_fails(self):
        module = MODULE + '''
class Out:
    def to_wire(self):
        return {"name": "x", "qty": "3"}
'''
        spec = SPEC + "    Out:\n      type: object\n      required: [name]\n      properties:\n        name: {type: string}\n        qty: {type: integer}\n"
        f = self.cls("Out", module=module, spec=spec)
        self.assertEqual(f.status, FAIL)
        self.assertIn("qty (emits {string}, contract {integer})", f.message)
        ok = self.cls("Out", module=module.replace('"3"', "3"), spec=spec)
        self.assertEqual(ok.status, OK)


PAY = '''\
class Pay:
    @classmethod
    def from_wire(cls, wire):
        if wire.get("method") != "cash":
            raise ValueError("method")
        return cls()
'''


class InlineLiterals(Case):                                   # P2
    def test_literal_equal_to_enum_passes(self):
        self.assertEqual(self.cls("Pay", module=PAY).status, OK)

    def test_literal_that_the_contract_widened_fails(self):
        f = self.cls("Pay", module=PAY, spec=SPEC.replace("enum: [cash]", "enum: [cash, card]"))
        self.assertEqual(f.status, FAIL)
        self.assertIn("method (connector accepts {cash}, contract {card, cash})", f.message)

    def test_mismatched_const_fails(self):
        module = PAY.replace('wire.get("method") != "cash"', 'wire.get("doctype") != "Batch"')
        module = module.replace('return cls()', 'return cls(wire["method"])')
        f = self.cls("Pay", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("doctype (connector accepts {Batch}, contract {Item})", f.message)

    def test_name_bound_to_the_field_and_not_in_set(self):
        module = PAY.replace('if wire.get("method") != "cash":', 'method = wire.get("method")\n        if method not in ("cash", "card"):')
        f = self.cls("Pay", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("connector accepts {card, cash}", f.message)

    def test_branch_literal_without_a_raise_is_not_an_acceptance_set(self):
        module = PAY.replace('if wire.get("method") != "cash":\n            raise ValueError("method")',
                             'if wire.get("method") == "card":\n            return None\n        wire["method"]')
        self.assertEqual(self.cls("Pay", module=module).status, OK)

    def test_literal_guard_nested_in_a_branch_is_not_counted(self):
        module = PAY.replace('if wire.get("method") != "cash":\n            raise ValueError("method")',
                             'if wire.get("doctype"):\n            if wire.get("method") != "card":\n                raise ValueError("m")\n        wire["method"]')
        self.assertEqual(self.cls("Pay", module=module).status, OK)


class RejectWhenAbsent(Case):                                 # P3
    @staticmethod
    def module(body):
        return f'''\
class Item:
    @classmethod
    def from_wire(cls, wire):
{body}
        return cls(wire["name"])
'''

    def test_required_shape_the_contract_marks_optional_fails(self):
        module = self.module('        if wire.get("qty") is None:\n            raise ValueError("qty")')
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("marks optional: {qty}", f.message)

    def test_required_shape_passes_when_the_contract_requires_it(self):
        module = self.module('        if wire.get("qty") is None:\n            raise ValueError("qty")')
        spec = SPEC.replace("required: [name]", "required: [name, qty]")
        self.assertEqual(self.cls("Item", module=module, spec=spec).status, OK)

    def test_other_guard_shapes_also_refuse_an_absent_field(self):
        for guard in ('if not wire.get("qty"):', 'if "qty" not in wire:', 'if wire.get("qty") != "x":',
                      'if not isinstance(wire.get("qty"), int):', 'if wire.get("tags") is None or wire.get("qty") is None:'):
            module = self.module(f"        {guard}\n            raise ValueError('x')")
            f = self.cls("Item", module=module)
            self.assertEqual(f.status, FAIL, guard)
            self.assertIn("marks optional", f.message, guard)

    def test_optional_shapes_stay_optional(self):
        shapes = {
            "nested in a branch": '        if "tags" in wire:\n            if wire.get("qty") is None:\n                raise ValueError("q")',
            "early return": '        if wire.get("qty") is None:\n            return None\n        if wire.get("qty") != 1:\n            raise ValueError("q")',
            "isinstance that allows None": '        if not isinstance(wire.get("qty"), (int, type(None))):\n            raise ValueError("q")',
            "raise with an else": '        if wire.get("qty") is None:\n            raise ValueError("q")\n        else:\n            pass',
            "guard after a loop": '        for _ in ():\n            pass\n        if wire.get("qty") is None:\n            raise ValueError("q")',
        }
        for name, body in shapes.items():
            f = self.cls("Item", module=self.module(body))
            self.assertEqual(f.status, OK, f"{name}: {f.message}")

    def test_guard_in_an_unconditionally_called_helper_counts(self):
        module = self.module('        _need(wire, "qty")') + '''
def _need(w, field):
    if w.get(field) is None:
        raise ValueError(field)
'''
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("marks optional: {qty}", f.message)

    def test_default_standing_in_for_an_absent_field_is_not_a_reject(self):
        for body in ('        mode = wire.get("qty", 0)\n        if mode is None:\n            raise ValueError("m")',
                     '        q = wire.get("qty", 1)\n        if q not in (1, 2):\n            raise ValueError("q")',
                     '        if not wire.get("qty", 1):\n            raise ValueError("q")'):
            f = self.cls("Item", module=self.module(body))
            self.assertEqual(f.status, OK, f"{body}: {f.message}")
        none_default = self.module('        if wire.get("qty", None) is None:\n            raise ValueError("q")')
        self.assertEqual(self.cls("Item", module=none_default).status, FAIL)

    def test_guard_in_a_helper_called_from_the_final_return_counts(self):
        module = MODULE.replace('wire.get("qty")', '_need(wire.get("qty"))') + """
def _need(raw):
    if raw is None:
        raise ValueError("qty")
    return raw
"""
        f = self.cls("Item", module=module)
        self.assertEqual(f.status, FAIL)
        self.assertIn("marks optional: {qty}", f.message)

    def test_guard_in_a_conditionally_called_helper_does_not_count(self):
        module = self.module('        if wire.get("tags"):\n            _need(wire, "qty")\n        x = _need(wire, "qty") if wire.get("tags") else None') + '''
def _need(w, field):
    if w.get(field) is None:
        raise ValueError(field)
'''
        self.assertEqual(self.cls("Item", module=module).status, OK)


class Survey(unittest.TestCase):
    def test_write_values_collects_dict_literal_and_assignments(self):
        import ast
        func = ast.parse('def to_wire(self):\n    out = {"a": 1}\n    out["b"] = "x"\n    return out\n').body[0]
        self.assertEqual(wire_facts.written_kinds(func), {"a": {"integer"}, "b": {"string"}})


if __name__ == "__main__":
    unittest.main()
