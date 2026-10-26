"""RT-870: policy approvers by immutable numeric id and actor type.

A listed `{id, type}` approver matches the actor's account id AND type, never its login.
The legacy plain-login form still works for a `User` only. Every other shape fails closed."""

import copy
import unittest

from pgraph import aggregate as ag
from pgraph.graph import load_graph, validate_graph

import support

HUMAN = {"id": 206601658, "type": "User", "login": "Kemetra"}
REVIEWER = {"id": 348508063, "type": "Bot", "login": "kemetra-reviewer[bot]"}
PLAN = {"head_sha": "h" * 40, "base_sha": "b" * 40, "policy_fingerprint": "f" * 64}


def _approval(**kw):
    base = {"login": "kemetra-reviewer[bot]", "actor_id": 348508063, "actor_type": "Bot", "kind": "review",
            "head_sha": PLAN["head_sha"], "base_sha": PLAN["base_sha"], "fingerprint": PLAN["policy_fingerprint"]}
    base.update(kw)
    return base


class CheckApprovalByIdTests(unittest.TestCase):

    def _check(self, approval, approvers=(HUMAN, REVIEWER)):
        return ag.check_approval(PLAN, [approval], list(approvers))

    def test_listed_bot_by_id_and_type_approves(self):
        self.assertEqual(self._check(_approval()), (True, []))

    def test_listed_human_by_id_and_type_approves(self):
        self.assertEqual(self._check(_approval(login="Kemetra", actor_id=206601658, actor_type="User")), (True, []))

    def test_renamed_login_with_the_same_id_still_approves(self):
        self.assertEqual(self._check(_approval(login="renamed-reviewer[bot]")), (True, []))

    def test_recycled_login_with_a_different_id_is_rejected(self):
        valid, problems = self._check(_approval(actor_id=999))
        self.assertFalse(valid)
        self.assertIn("NOT_APPROVER", problems)

    def test_same_id_with_the_wrong_type_is_rejected(self):
        valid, problems = self._check(_approval(actor_type="User"))
        self.assertFalse(valid)
        self.assertIn("NOT_APPROVER", problems)

    def test_missing_or_non_int_actor_id_is_rejected(self):
        for bad in (None, "348508063", 348508063.0, True):
            with self.subTest(actor_id=bad):
                valid, problems = self._check(_approval(actor_id=bad))
                self.assertFalse(valid)
                self.assertIn("NOT_APPROVER", problems)

    def test_bool_id_in_the_list_cannot_match_the_number_one(self):
        valid, _ = self._check(_approval(actor_id=1, actor_type="Bot"), approvers=[{"id": True, "type": "Bot"}])
        self.assertFalse(valid)

    def test_unlisted_bot_is_rejected(self):
        valid, problems = self._check(_approval(login="other[bot]", actor_id=1), approvers=[HUMAN])
        self.assertFalse(valid)
        self.assertEqual(set(problems), {"NOT_APPROVER", "NOT_HUMAN"})

    def test_stale_head_base_and_fingerprint_still_fail_for_a_listed_bot(self):
        for field, code in (("head_sha", "STALE_HEAD"), ("base_sha", "STALE_BASE"), ("fingerprint", "STALE_POLICY")):
            with self.subTest(field=field):
                valid, problems = self._check(_approval(**{field: "0" * 40}))
                self.assertFalse(valid)
                self.assertEqual(problems, [code])

    def test_label_is_never_an_approval_even_from_a_listed_bot(self):
        valid, problems = self._check(_approval(kind="label"))
        self.assertFalse(valid)
        self.assertEqual(problems, ["LABEL_NOT_SHA_BOUND"])

    def test_legacy_login_string_still_needs_a_user(self):
        self.assertEqual(ag.check_approval(PLAN, [_approval(login="Kemetra", actor_type="User", actor_id=1)],
                                           ["Kemetra"]), (True, []))
        valid, problems = ag.check_approval(PLAN, [_approval(login="Kemetra", actor_type="Bot")], ["Kemetra"])
        self.assertFalse(valid)
        self.assertEqual(problems, ["NOT_HUMAN"])

    def test_a_login_string_never_admits_a_bot_by_id(self):
        valid, _ = ag.check_approval(PLAN, [_approval()], ["kemetra-reviewer[bot]"])
        self.assertFalse(valid)

    def test_an_id_entry_never_admits_by_login_alone(self):
        valid, _ = ag.check_approval(PLAN, [_approval(actor_id=None)], [REVIEWER])
        self.assertFalse(valid)


class ApproverSchemaTests(unittest.TestCase):

    def _validate(self, approvers):
        graph = load_graph(support.trusted_text())
        graph = copy.deepcopy(graph)
        graph["policy_approvers"] = approvers
        return [e for e in validate_graph(graph, workflow_jobs=dict(graph["jobs"])) if e.startswith("SCHEMA")]

    def test_id_and_type_entries_validate(self):
        self.assertEqual(self._validate([HUMAN, REVIEWER, {"id": 5, "type": "Bot"}, "legacy-login"]), [])

    def test_malformed_entries_are_schema_errors(self):
        bad = [
            {"type": "Bot"},                                  # no id
            {"id": 5},                                        # no type
            {"id": 5, "type": "Organization"},                # unknown type
            {"id": 0, "type": "Bot"},                         # not positive
            {"id": -3, "type": "Bot"},
            {"id": True, "type": "Bot"},                      # bool is not an id
            {"id": "5", "type": "Bot"},                       # string id
            {"id": 5, "type": "Bot", "token": "x"},           # unknown key
            {"id": 5, "type": "Bot", "login": 7},             # label must be a string
            5,
            None,
            ["Kemetra"],
        ]
        for entry in bad:
            with self.subTest(entry=entry):
                self.assertTrue(self._validate([entry]), entry)

    def test_non_list_is_still_a_schema_error(self):
        self.assertTrue(self._validate("Kemetra"))


if __name__ == "__main__":
    unittest.main()
