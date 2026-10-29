import textwrap
import unittest

from contracts_check import connector
from contracts_check.findings import DRIFT, FAIL, OK

from support import TempRepo

SPEC = """\
openapi: 3.1.0
info: {title: t, version: 1.4.0-draft}
paths: {}
components:
  schemas:
    Amount: {type: string, pattern: '^[0-9]{1,15}(\\.[0-9]{1,4})?$'}
    Tender:
      type: object
      required: [method, amount]
      properties:
        method: {type: string, enum: [cash, card_external]}
        amount: {$ref: '#/components/schemas/Amount'}
        reference: {type: string, pattern: '^[A-Z0-9]{1,6}$'}
    Ref:
      type: object
      required: [doctype, name]
      properties:
        doctype: {const: Item}
        name: {type: string}
    Reversal:
      type: object
      required: [kind]
      properties:
        kind: {type: string}
        recordedAt: {type: string}
      allOf:
        - if: {properties: {kind: {const: void}}}
          then: {required: [recordedAt]}
"""

MODULE = '''\
"""Mirrors tender.yaml 1.4.0-draft."""
import re

METHODS: frozenset[str] = frozenset({"cash", "card_external"})
DOCTYPES = frozenset({"Item"})
_AMOUNT_RE = re.compile(r"^\\d{1,15}(\\.\\d{1,4})?$", re.ASCII)
_REF_RE = re.compile(r"^[A-Z0-9]{1,6}$")


def _require(wire, name):
    return wire


def _amount(wire, field, name):
    return wire.get(field)


class Tender:
    @classmethod
    def from_wire(cls, wire):
        w = _require(wire, "Tender")
        ref = None if w.get("reference") is None else str(w["reference"])
        return cls(w["method"], _amount(w, "amount", "Tender"), ref)


class Ref:
    def to_wire(self):
        out = {"doctype": "Item"}
        out["name"] = self.name
        return out


class Reversal:
    @classmethod
    def from_wire(cls, wire):
        return cls(wire["kind"], wire.get("recordedAt"))
'''

ENTRY = {
    "module": "mod/contracts.py",
    "contract": "c/tender.yaml",
    "enums": {"METHODS": "Tender/properties/method", "DOCTYPES": "Ref/properties/doctype"},
    "patterns": {"_AMOUNT_RE": "Amount", "_REF_RE": "Tender/properties/reference"},
    "local": {},
}


class ConnectorCase(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)

    def check(self, module=MODULE, spec=SPEC, entry=None):
        self.repo.write("mod/contracts.py", module)
        self.repo.write("contracts/c/tender.yaml", spec)
        return connector.check_module(self.repo.root, entry or ENTRY, "contracts")

    def by_subject(self, findings, suffix):
        hits = [f for f in findings if f.subject.endswith(suffix)]
        self.assertEqual(len(hits), 1, f"{suffix}: {findings}")
        return hits[0]

    def assert_no_fail(self, findings):
        self.assertEqual([f for f in findings if f.status == FAIL], [])

    def test_baseline_passes(self):
        findings = self.check()
        self.assert_no_fail(findings)
        self.assertEqual(self.by_subject(findings, "version").status, OK)
        self.assertEqual(self.by_subject(findings, "METHODS").status, OK)
        self.assertEqual(self.by_subject(findings, "DOCTYPES").status, OK)    # const
        # \d under re.ASCII equals [0-9]; the trailing Python `$` is reported as drift.
        self.assertEqual(self.by_subject(findings, "_AMOUNT_RE").status, DRIFT)
        self.assertIn("trailing newline", self.by_subject(findings, "_AMOUNT_RE").message)

    def test_end_anchor_z_is_exact(self):
        module = MODULE.replace('{1,6}$")', '{1,6}\\Z")')
        spec = SPEC.replace("'^[A-Z0-9]{1,6}$'", "'^[A-Z0-9]{1,6}\\Z'")
        self.assertEqual(self.by_subject(self.check(module=module, spec=spec), "_REF_RE").status, OK)

    def test_connector_z_matches_contract_dollar(self):
        # RT-915: the contract keeps ECMA `$`; the connector's `\Z` is the same exact end, not a mismatch.
        module = MODULE.replace('{1,6}$")', '{1,6}\\Z")')
        f = self.by_subject(self.check(module=module), "_REF_RE")
        self.assertEqual(f.status, OK)

    def test_escaped_z_is_not_an_anchor(self):
        self.assertEqual(connector._canonical_end(r"^a\Z"), "^a$")
        self.assertEqual(connector._canonical_end(r"^a\\Z"), r"^a\\Z")
        self.assertEqual(connector._canonical_end("^a$"), "^a$")

    def test_escaped_dollar_is_not_an_anchor(self):
        self.assertFalse(connector._ends_with_dollar(r"^a\$"))
        self.assertTrue(connector._ends_with_dollar(r"^a\\$"))
        self.assertTrue(connector._ends_with_dollar("^a$"))

    def test_unicode_word_class_without_ascii_fails(self):
        module = MODULE.replace('_REF_RE = re.compile(r"^[A-Z0-9]{1,6}$")', '_REF_RE = re.compile(r"^\\w{1,6}$")')
        spec = SPEC.replace("'^[A-Z0-9]{1,6}$'", "'^\\w{1,6}$'")
        f = self.by_subject(self.check(module=module, spec=spec), "_REF_RE")
        self.assertEqual(f.status, FAIL)
        self.assertIn("non-ASCII", f.message)
        ok = self.by_subject(self.check(module=module.replace('{1,6}$")', '{1,6}$", re.ASCII)'), spec=spec), "_REF_RE")
        self.assertNotEqual(ok.status, FAIL)

    def test_keyword_bound_helper_field_is_read(self):
        module = MODULE.replace('_amount(w, "amount", "Tender")', '_amount(w, name="Tender", field="amt")')
        f = self.by_subject(self.check(module=module), "Tender")
        self.assertEqual(f.status, FAIL)
        self.assertIn("{amt}", f.message)

    def test_unresolvable_read_key_fails(self):
        module = MODULE.replace('cls(wire["kind"], wire.get("recordedAt"))', 'cls(wire["kind"], wire.get(KEY))')
        f = self.by_subject(self.check(module=module), "Reversal")
        self.assertEqual(f.status, FAIL)
        self.assertIn("cannot be resolved", f.message)

    def test_enum_value_only_in_contract_fails(self):
        f = self.by_subject(self.check(spec=SPEC.replace("[cash, card_external]", "[cash, card_external, voucher]")),
                            "METHODS")
        self.assertEqual(f.status, FAIL)
        self.assertIn("contract only: {voucher}", f.message)

    def test_enum_value_only_in_connector_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace('{"cash", "card_external"}', '{"cash", "card_external", "x"}')),
                            "METHODS")
        self.assertEqual(f.status, FAIL)
        self.assertIn("connector only: {x}", f.message)

    def test_digit_class_without_ascii_flag_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace(", re.ASCII)", ")")), "_AMOUNT_RE")
        self.assertEqual(f.status, FAIL)
        self.assertIn("non-ASCII digits", f.message)

    def test_extra_flag_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace('{1,6}$")', '{1,6}$", re.IGNORECASE)')), "_REF_RE")
        self.assertEqual(f.status, FAIL)

    def test_pattern_change_fails(self):
        f = self.by_subject(self.check(spec=SPEC.replace("[A-Z0-9]{1,6}", "[A-Z0-9]{1,8}")), "_REF_RE")
        self.assertEqual(f.status, FAIL)
        self.assertIn("pattern mismatch", f.message)

    def test_pattern_followed_through_ref(self):
        f = self.by_subject(self.check(spec=SPEC.replace("{1,15}(", "{1,12}(", 1)), "_AMOUNT_RE")
        self.assertEqual(f.status, FAIL)

    def test_unclassified_constant_fails(self):
        f = self.by_subject(self.check(module=MODULE + '\nNEW_SET = frozenset({"a"})\n'), "NEW_SET")
        self.assertEqual(f.status, FAIL)
        self.assertIn("not classified", f.message)

    def test_unclassified_regex_fails(self):
        f = self.by_subject(self.check(module=MODULE + '\n_NEW_RE = re.compile("x")\n'), "_NEW_RE")
        self.assertEqual(f.status, FAIL)

    def test_non_literal_frozenset_fails(self):
        f = self.by_subject(self.check(module=MODULE + "\nDERIVED = frozenset(METHODS)\n"), "DERIVED")
        self.assertEqual(f.status, FAIL)
        self.assertIn("not a literal", f.message)

    def test_local_constant_is_accepted_and_stale_local_fails(self):
        entry = dict(ENTRY, local={"EXTRA": "connector rule", "GONE": "stale"})
        findings = self.check(module=MODULE + '\nEXTRA = frozenset({"a"})\n', entry=entry)
        self.assertFalse([f for f in findings if f.subject.endswith("EXTRA")])
        self.assertEqual(self.by_subject(findings, "GONE").status, FAIL)

    def test_mapped_constant_missing_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace("METHODS:", "RENAMED:")), "METHODS")
        self.assertEqual(f.status, FAIL)

    def test_read_of_unknown_field_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace('w.get("reference")', 'w.get("ref")')), "Tender")
        self.assertEqual(f.status, FAIL)
        self.assertIn("{ref}", f.message)

    def test_read_through_helper_field_argument(self):
        f = self.by_subject(self.check(module=MODULE.replace('"amount", "Tender"', '"amt", "Tender"')), "Tender")
        self.assertEqual(f.status, FAIL)
        self.assertIn("{amt}", f.message)

    def test_bare_subscript_of_optional_field_fails(self):
        spec = SPEC.replace("required: [method, amount]", "required: [amount]")
        f = self.by_subject(self.check(spec=spec), "Tender")
        self.assertEqual(f.status, FAIL)
        self.assertIn("marks optional: {method}", f.message)

    def test_guarded_subscript_is_optional(self):
        # w["reference"] is read only after w.get("reference"): reference is not required.
        self.assertEqual(self.by_subject(self.check(), "Tender").status, OK)

    def test_conditional_allof_required_is_not_merged(self):
        spec = SPEC.replace("required: [kind]\n", "required: []\n", 1)
        f = self.by_subject(self.check(spec=spec), "Reversal")
        self.assertEqual(f.status, FAIL)   # kind read bare, no longer required
        self.assertNotIn("recordedAt", f.message)

    def test_unconditional_allof_is_merged(self):
        spec = SPEC.replace("required: [kind]\n", "required: []\n", 1).replace(
            "      allOf:\n", "      allOf:\n        - required: [kind]\n")
        self.assertEqual(self.by_subject(self.check(spec=spec), "Reversal").status, OK)

    def test_to_wire_missing_required_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace('        out["name"] = self.name\n', "")), "Ref")
        self.assertEqual(f.status, FAIL)
        self.assertIn("never emits required field(s): {name}", f.message)

    def test_to_wire_unknown_field_fails(self):
        f = self.by_subject(self.check(module=MODULE.replace('out["name"]', 'out["nom"]')), "Ref")
        self.assertEqual(f.status, FAIL)
        self.assertIn("emits field(s) not in the contract: {nom}", f.message)

    def test_nested_dict_keys_are_not_top_level(self):
        module = MODULE.replace('out = {"doctype": "Item"}', 'out = {"doctype": "Item", "name": {"inner": 1}}')
        self.assertEqual(self.by_subject(self.check(module=module), "Ref").status, OK)

    def test_class_without_schema_fails(self):
        module = MODULE + "\n\nclass Orphan:\n    def to_wire(self):\n        return {}\n"
        f = self.by_subject(self.check(module=module), "Orphan")
        self.assertEqual(f.status, FAIL)

    def test_version_drift_is_reported_not_failed(self):
        findings = self.check(spec=SPEC.replace("1.4.0-draft", "1.10.0-draft"))
        f = self.by_subject(findings, "version")
        self.assertEqual(f.status, DRIFT)
        self.assertIn("1.4.0-draft", f.message)
        self.assert_no_fail(findings)

    def test_unreadable_contract_fails(self):
        self.repo.write("mod/contracts.py", MODULE)
        findings = connector.check_module(self.repo.root, ENTRY, "contracts")
        self.assertEqual([f.status for f in findings], [FAIL])

    def test_syntax_error_fails(self):
        findings = self.check(module="def broken(:\n")
        self.assertEqual([f.status for f in findings], [FAIL])


class PatternNormalisation(unittest.TestCase):
    def test_digit_class(self):
        self.assertEqual(connector.normalise_pattern(r"^\d+[\d.]$", True), r"^[0-9]+[0-9.]$")
        self.assertEqual(connector.normalise_pattern(r"^\d$", False), r"^\d$")
        self.assertEqual(connector.normalise_pattern(r"\\d", True), r"\\d")   # escaped backslash


if __name__ == "__main__":
    unittest.main()
