"""Phase-4 S2: offline, dry-run-first Port writer executor (RT-1391).

No network, no Port credentials. GitHub and Port are reached only through an injected
transport; here that is a fake which records every call and can change state at an exact call
number, so every race the executor guards against is reproduced deterministically. Evidence comes
from real temporary Git repositories (shared with the S1 tests)."""

import ast
import copy
import json
import pathlib
import unittest
from collections import Counter
from unittest.mock import patch

from pgraph import port_sync as ps
from pgraph import port_writer as pw

import test_port_sync as base

HEAD40 = base.HEAD40
OTHER40 = base.OTHER40
POS_SERVICE = {"identifier": "pos", "title": "POS"}


def stored_entity(number=559, **overrides):
    """A Port entity with the legacy `service` relation set, as 98 real PR entities have today."""
    relations = overrides.pop("relations", {})
    relations.setdefault("service", dict(POS_SERVICE))
    return base.entity(number, relations=relations, **overrides)


class FakeGithub:
    def __init__(self, tip, prs, detached=True):
        self.tip = tip
        self.detached = detached             # False: hand out the stored objects themselves
        self.prs = {p["number"]: dict(p) for p in prs}
        self.counts = Counter()
        self.hooks = {}                      # (method, n-th call) -> callable(self)

    def _tick(self, name):
        self.counts[name] += 1
        hook = self.hooks.get((name, self.counts[name]))
        if hook:
            hook(self)

    def main_sha(self):
        self._tick("main_sha")
        return self.tip

    def get_pr(self, number):
        self._tick("get_pr")
        pr = self.prs.get(number)
        return copy.deepcopy(pr) if self.detached else pr


class FakePort:
    def __init__(self, entities, services=None, detached=True):
        self.detached = detached             # False: hand out the stored objects themselves
        self.entities = copy.deepcopy(entities)
        self.services = set(ps.SERVICES if services is None else services)
        self.patches = []
        self.counts = Counter()
        self.hooks = {}
        self.fail_patch = None
        self.apply_patch = True
        self.drop_service = False
        self.break_find_after_patch = False

    def _tick(self, name):
        self.counts[name] += 1
        hook = self.hooks.get((name, self.counts[name]))
        if hook:
            hook(self)

    def find_entities(self, number):
        self._tick("find_entities")
        if self.break_find_after_patch and self.patches:
            raise OSError("read failed")
        found = [e for e in self.entities if e.get("properties", {}).get("prNumber") == number]
        return copy.deepcopy(found) if self.detached else found

    def service_ids(self):
        self._tick("service_ids")
        return sorted(self.services)

    def patch_entity(self, request):
        self.counts["patch_entity"] += 1
        self.patches.append(copy.deepcopy(request))
        if self.fail_patch is not None:
            raise self.fail_patch
        if not self.apply_patch:
            return {"ok": True}
        target = request["path"].rsplit("/", 1)[1]
        entity = next(e for e in self.entities if e["identifier"] == target)
        entity["properties"].update(request["body"]["properties"])
        entity["relations"]["affected_services"] = [
            {"identifier": s, "title": s} for s in request["body"]["relations"]["affected_services"]]
        if self.drop_service:
            entity["relations"]["service"] = None
        return {"ok": True}


class Executor(base.Scenario):
    def setUp(self):
        super().setUp()
        self.pr = base.pr(number=559, head_sha=self.sha["f2"])
        self.github = FakeGithub(self.tip, [self.pr])
        self.port = FakePort([stored_entity(559)])

    def go(self, **kw):
        tip = kw.pop("tip", self.tip)
        number = kw.pop("number", 559)
        report = pw.run(self.repo, tip, number, self.github, self.port, **kw)
        json.dumps(report)                   # every report, on every path, must be plain JSON
        return report

    def approved(self):
        return self.go()["digest"]

    def apply(self, digest=None, **kw):
        """Approve via a dry run, then apply. Call counters restart, so hooks keyed by call number
        see: 1 = snapshot, 2 = pre-write recheck, 3 = post-write verification."""
        digest = digest or self.approved()
        self.github.counts.clear()
        self.port.counts.clear()
        return self.go(apply=True, expected_digest=digest, **kw)

    def no_calls(self):
        self.assertEqual(dict(self.github.counts), {})
        self.assertEqual(dict(self.port.counts), {})


class DryRunTests(Executor):
    def test_dry_run_is_the_default_and_never_calls_the_write_method(self):
        report = self.go()
        self.assertEqual((report["mode"], report["result"], report["writes"]), ("dry-run", "dry_run", 0))
        self.assertEqual(self.port.patches, [])
        self.assertEqual(self.port.counts["patch_entity"], 0)
        plan = ps.plan_all(self.repo, [self.pr], [stored_entity(559)], self.tip, frozenset(ps.SERVICES))
        self.assertEqual(report["request"], plan["items"][0]["request"])
        self.assertEqual(report["request"]["body"]["relations"], {"affected_services": ["backend-core", "pos"]})

    def test_report_names_the_trusted_evidence_and_a_rollback(self):
        report = self.go()
        self.assertEqual((report["entity"], report["head_sha"], report["main_tip"]),
                         ("Retail-Tower-Erp-pr-559", self.sha["f2"], self.tip))
        self.assertRegex(report["digest"], r"\A[0-9a-f]{64}\Z")
        self.assertEqual(report["before"], {"properties": {k: None for k in ps.WRITER_PROPERTIES},
                                            "services": []})
        rollback = report["rollback_request"]
        ps.validate_request(rollback)
        self.assertEqual(rollback["body"]["relations"], {"affected_services": []})
        self.assertTrue(all(v is None for v in rollback["body"]["properties"].values()))

    def test_the_request_never_contains_the_legacy_service_relation(self):
        body = self.go()["request"]["body"]
        self.assertEqual(set(body), {"properties", "relations"})
        self.assertEqual(set(body["relations"]), {"affected_services"})
        self.assertEqual(set(body["properties"]), set(ps.WRITER_PROPERTIES))

    def test_digest_is_deterministic_and_binds_request_head_and_stored_state(self):
        first = self.approved()
        self.assertEqual(first, self.approved())
        other_head = FakeGithub(self.tip, [base.pr(number=559, head_sha=self.sha["f1"])])
        self.assertNotEqual(first, pw.run(self.repo, self.tip, 559, other_head, self.port)["digest"])
        pending = FakePort([stored_entity(559, properties={"attribution_status": "pending"})])
        self.assertNotEqual(first, pw.run(self.repo, self.tip, 559, self.github, pending)["digest"])

    def test_the_digest_binds_the_head_even_when_the_request_does_not_carry_it(self):
        # Deterministic insufficient evidence writes no evidence URL, so both requests are identical;
        # only the head tells the two approvals apart.
        digests = set()
        for head in (self.sha["c0"], self.sha["c1"]):               # both already in main
            github = FakeGithub(self.tip, [base.pr(number=559, head_sha=head)])
            report = pw.run(self.repo, self.tip, 559, github, FakePort([stored_entity(559)]))
            self.assertEqual(report["plan"]["desired"]["properties"]["attribution_status"],
                             "insufficient_evidence")
            digests.add((json.dumps(report["request"], sort_keys=True), report["digest"]))
        self.assertEqual(len({request for request, _ in digests}), 1)
        self.assertEqual(len({digest for _, digest in digests}), 2)

    def test_an_entity_already_up_to_date_is_a_noop_with_no_digest_to_approve(self):
        self.apply()
        again = self.go()
        self.assertEqual((again["result"], again["reasons"]), ("noop", ["UP_TO_DATE"]))
        self.assertIsNone(again["request"])

    def test_every_planner_skip_is_blocked_without_a_request(self):
        cases = {
            "PORT_ENTITY_MISSING": FakePort([]),
            "PORT_ENTITY_AMBIGUOUS": FakePort([stored_entity(559), stored_entity(559)]),
            "PORT_SERVICE_MISSING": FakePort([stored_entity(559)], services={"pos"}),
        }
        for reason, port in cases.items():
            with self.subTest(reason=reason):
                report = pw.run(self.repo, self.tip, 559, self.github, port)
                self.assertEqual((report["result"], report["reasons"]), ("blocked", [reason]))
                self.assertIsNone(report["request"])
                self.assertEqual(port.patches, [])

    def test_a_stale_trusted_tip_is_blocked_before_anything_is_planned(self):
        self.github.tip = "f" * 40
        report = self.go()
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["STALE_MAIN_TIP"]))
        self.assertEqual(self.github.counts["get_pr"], 0)

    def test_a_snapshot_for_another_pr_is_blocked(self):
        self.github.prs[559]["number"] = 560
        report = self.go()
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["PR_NUMBER_MISMATCH"]))

    def test_a_missing_pr_snapshot_is_blocked(self):
        report = self.go(number=777)
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["PR_SNAPSHOT_UNAVAILABLE"]))

    def test_a_failing_read_is_blocked_not_raised(self):
        self.port.hooks[("find_entities", 1)] = lambda p: (_ for _ in ()).throw(OSError("down"))
        report = self.go()
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["TRANSPORT_READ_FAILED"]))

    def test_classifier_infrastructure_failure_is_never_a_verdict(self):
        report = pw.run(self.repo, self.tip, 559, FakeGithub(self.tip, [base.pr(number=559, head_sha="e" * 40)]),
                        self.port)
        self.assertIn(report["result"], ("blocked", "noop"))
        self.assertIsNone(report["request"])

    def test_a_tampered_plan_that_carries_the_legacy_service_is_refused_in_both_modes(self):
        plan = ps.plan_all(self.repo, [self.pr], [stored_entity(559)], self.tip, frozenset(ps.SERVICES))
        plan["items"][0]["request"]["body"]["relations"]["service"] = "pos"
        with patch.object(pw.port_sync, "plan_all", return_value=plan):
            dry = self.go()
            applied = self.go(apply=True, expected_digest="a" * 64)
        for report in (dry, applied):
            self.assertEqual((report["result"], report["reasons"]), ("refused", ["FORBIDDEN_REQUEST"]))
        self.assertEqual(self.port.patches, [])

    def test_a_before_state_the_request_cannot_restore_has_no_rollback(self):
        port = FakePort([stored_entity(559, properties={"attribution_status": "failed"})])
        report = pw.run(self.repo, self.tip, 559, self.github, port)
        self.assertEqual(report["result"], "dry_run")
        self.assertIsNone(report["rollback_request"])
        self.assertEqual(report["rollback_note"], "BEFORE_STATE_NOT_REPRESENTABLE")


class ApplyGuardTests(Executor):
    def test_apply_without_a_digest_is_refused_with_no_transport_calls(self):
        for digest in (None, "", "abc", "A" * 64, 5):
            with self.subTest(digest=digest):
                report = self.go(apply=True, expected_digest=digest)
                self.assertEqual((report["result"], report["reasons"]), ("refused", ["DIGEST_REQUIRED"]))
                self.no_calls()

    def test_apply_with_a_digest_of_another_plan_writes_nothing(self):
        report = self.go(apply=True, expected_digest="0" * 64)
        self.assertEqual((report["result"], report["reasons"]), ("refused", ["PLAN_DIGEST_MISMATCH"]))
        self.assertEqual(self.port.patches, [])

    def test_a_digest_approved_for_one_head_cannot_authorize_another(self):
        approved = self.approved()
        self.github.prs[559]["head_sha"] = self.sha["f1"]
        report = self.go(apply=True, expected_digest=approved)
        self.assertEqual((report["result"], report["reasons"]), ("refused", ["PLAN_DIGEST_MISMATCH"]))
        self.assertEqual(self.port.patches, [])

    def test_a_zero_write_cap_refuses_apply_with_no_transport_calls(self):
        report = self.go(apply=True, expected_digest="a" * 64, max_writes=0)
        self.assertEqual((report["result"], report["reasons"]), ("refused", ["WRITE_CAP_EXHAUSTED"]))
        self.no_calls()

    def test_invalid_inputs_are_refused_with_no_transport_calls(self):
        for number in (True, 0, -1, "559", None, 5.5):
            with self.subTest(number=number):
                self.assertEqual(self.go(number=number)["reasons"], ["INVALID_INPUT"])
        for tip in ("main", "", None, "A" * 40):
            with self.subTest(tip=tip):
                self.assertEqual(self.go(tip=tip)["reasons"], ["INVALID_INPUT"])
        for cap in (True, -1, "1", None):
            with self.subTest(cap=cap):
                self.assertEqual(self.go(max_writes=cap)["reasons"], ["INVALID_INPUT"])
        self.no_calls()

    def test_apply_must_be_exactly_true(self):
        self.assertEqual(self.go(apply="yes", expected_digest="a" * 64)["reasons"], ["INVALID_INPUT"])
        self.no_calls()


class RecheckTests(Executor):
    """Port has no conditional write, so the executor re-reads everything immediately before it."""

    def assert_blocked(self, *reasons):
        report = self.apply()
        self.assertEqual((report["result"], report["reasons"], report["writes"]),
                         ("blocked", sorted(reasons), 0))
        self.assertEqual(self.port.patches, [])
        self.assertEqual(self.port.counts["patch_entity"], 0)

    def test_main_moving_between_snapshot_and_write_blocks(self):
        self.github.hooks[("main_sha", 2)] = lambda g: setattr(g, "tip", "c" * 40)
        self.assert_blocked("STALE_MAIN_TIP")

    def test_head_moving_between_snapshot_and_write_blocks(self):
        self.github.hooks[("get_pr", 2)] = lambda g: g.prs[559].update(head_sha=self.sha["f1"])
        self.assert_blocked("STALE_HEAD")

    def test_pr_state_changing_between_snapshot_and_write_blocks(self):
        self.github.hooks[("get_pr", 2)] = lambda g: g.prs[559].update(state="closed", merged=True)
        self.assert_blocked("PR_CHANGED")

    def test_a_disappearing_pr_snapshot_blocks(self):
        self.github.hooks[("get_pr", 2)] = lambda g: g.prs.clear()
        self.assert_blocked("PR_CHANGED")

    def test_another_property_changing_on_the_entity_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities[0]["properties"].update(has_reviewers=True)
        self.assert_blocked("ENTITY_CHANGED")

    def test_another_writer_touching_a_writer_field_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities[0]["properties"].update(
            attribution_status="pending")
        self.assert_blocked("ENTITY_CHANGED")

    def test_the_legacy_service_relation_changing_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities[0]["relations"].update(service=None)
        self.assert_blocked("ENTITY_CHANGED")

    def test_the_entity_becoming_ambiguous_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities.append(stored_entity(559))
        self.assert_blocked("ENTITY_CHANGED")

    def test_a_service_disappearing_blocks(self):
        self.port.hooks[("service_ids", 2)] = lambda p: p.services.discard("pos")
        self.assert_blocked("SERVICE_MISSING")

    def test_a_failing_recheck_read_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: (_ for _ in ()).throw(OSError("down"))
        self.assert_blocked("TRANSPORT_READ_FAILED")

    def test_all_reasons_are_reported_together(self):
        self.github.hooks[("get_pr", 2)] = lambda g: g.prs[559].update(head_sha=self.sha["f1"])
        self.port.hooks[("service_ids", 2)] = lambda p: p.services.discard("pos")
        self.assert_blocked("SERVICE_MISSING", "STALE_HEAD")


class ApplyTests(Executor):
    def test_a_verified_write_sends_exactly_one_exact_patch(self):
        digest = self.approved()
        report = self.go(apply=True, expected_digest=digest)
        self.assertEqual((report["result"], report["mode"], report["writes"]), ("written", "apply", 1))
        self.assertEqual(len(self.port.patches), 1)
        sent = self.port.patches[0]
        self.assertEqual(sent, report["request"])
        ps.validate_request(sent)
        self.assertEqual(sent["path"], "/v1/blueprints/githubPullRequest/entities/Retail-Tower-Erp-pr-559")
        self.assertEqual(sent["query"], {"create_missing_related_entities": "false"})
        self.assertNotIn("service", sent["body"]["relations"])
        self.assertTrue(all(check["ok"] for check in report["checks"]), report["checks"])
        self.assertEqual(report["violations"], [])

    def test_the_after_state_equals_the_desired_state_and_the_legacy_relation_survives(self):
        report = self.apply()
        self.assertEqual(report["after"]["services"], ["backend-core", "pos"])
        self.assertEqual(report["after"]["properties"], report["request"]["body"]["properties"])
        stored = self.port.entities[0]
        self.assertEqual(stored["relations"]["service"], POS_SERVICE)
        self.assertEqual(stored["properties"]["prNumber"], 559)

    def test_a_second_run_is_a_noop_with_zero_writes_even_with_the_old_digest(self):
        digest = self.approved()
        self.assertEqual(self.go(apply=True, expected_digest=digest)["result"], "written")
        again = self.go(apply=True, expected_digest=digest)
        self.assertEqual((again["result"], again["reasons"], again["writes"]), ("noop", ["UP_TO_DATE"], 0))
        self.assertEqual(len(self.port.patches), 1)

    def test_a_merged_pr_classified_for_its_final_head_is_frozen_after_one_write(self):
        self.github.prs[559].update(state="closed", merged=True)
        self.assertEqual(self.apply()["result"], "written")
        again = self.go()
        self.assertEqual((again["result"], again["reasons"]), ("noop", ["FROZEN_MERGED"]))
        self.assertEqual(len(self.port.patches), 1)

    def test_a_cleared_list_is_written_for_deterministic_insufficient_evidence(self):
        self.port = FakePort([stored_entity(559, properties={"attribution_status": "classified",
                                                              "attribution_scope": "single"},
                                            relations={"affected_services": [{"identifier": "pos"}]})])
        self.github.prs[559]["head_sha"] = self.sha["c0"]            # head already in main
        report = self.apply()
        self.assertEqual(report["result"], "written")
        self.assertEqual(self.port.entities[0]["relations"]["affected_services"], [])
        self.assertEqual(self.port.entities[0]["properties"]["attribution_status"], "insufficient_evidence")

    def test_open_and_squash_merged_prs_are_classified_from_the_whole_branch(self):
        services = {"affected_services": ["backend-core", "pos"]}
        self.assertEqual(self.go()["request"]["body"]["relations"], services)          # open

        base.git(self.repo, "merge", "--squash", "-q", "feature")
        base.git(self.repo, "commit", "-q", "-m", "squash")
        squash = self.tip_now()
        self.github.tip = squash
        self.github.prs[559].update(state="closed", merged=True, merge_commit_sha=squash)
        self.assertEqual(self.go(tip=squash)["request"]["body"]["relations"], services)  # squash

    def test_rebase_merge_is_not_reduced_to_the_last_replayed_commit(self):
        base.git(self.repo, "cherry-pick", self.sha["f1"], self.sha["f2"])
        last = self.tip_now()
        self.github.tip = last
        self.github.prs[559].update(state="closed", merged=True, merge_commit_sha=last)
        report = self.go(tip=last)
        self.assertEqual(report["request"]["body"]["relations"], {"affected_services": ["backend-core", "pos"]})

    def test_merge_commit_merge_records_the_policy_of_the_first_parent_graph(self):
        base.git(self.repo, "merge", "--no-ff", "-q", "-m", "merge", "feature")
        merge = self.tip_now()
        self.github.tip = merge
        self.github.prs[559].update(state="closed", merged=True, merge_commit_sha=merge)
        report = self.go(tip=merge)
        self.assertEqual(report["request"]["body"]["relations"], {"affected_services": ["backend-core", "pos"]})
        recorded = report["request"]["body"]["properties"]["classification_policy_ref"]
        self.assertEqual(recorded, ps.policy_ref(self.repo, self.sha["c1"]))


class AliasedTransportTests(Executor):
    """The transport contract does not promise detached objects. A transport that hands out its own
    cached objects must not be able to move the executor's before-state baselines."""

    def setUp(self):
        super().setUp()
        self.github = FakeGithub(self.tip, [self.pr], detached=False)
        self.port = FakePort([stored_entity(559)], detached=False)

    def test_an_in_place_write_that_clobbers_the_legacy_service_is_still_detected(self):
        self.port.drop_service = True
        report = self.apply()
        self.assertEqual(report["result"], "verify_failed")
        self.assertIn("PRESERVED_FIELDS_CHANGED", report["violations"])

    def test_an_entity_changed_in_place_before_the_write_still_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities[0]["properties"].update(has_reviewers=True)
        report = self.apply()
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["ENTITY_CHANGED"]))
        self.assertEqual(self.port.patches, [])

    def test_a_writer_field_changed_in_place_before_the_write_still_blocks(self):
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities[0]["properties"].update(
            attribution_status="pending")
        self.assertEqual(self.apply()["reasons"], ["ENTITY_CHANGED"])

    def test_a_pr_changed_in_place_before_the_write_still_blocks(self):
        self.github.hooks[("get_pr", 2)] = lambda g: g.prs[559].update(state="closed", merged=True)
        report = self.apply()
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["PR_CHANGED"]))
        self.assertEqual(self.port.patches, [])

    def test_the_report_does_not_alias_the_transport_either(self):
        report = self.go()
        self.port.entities[0]["properties"]["status"] = "closed"
        self.assertEqual(report["before"]["properties"], {k: None for k in ps.WRITER_PROPERTIES})


class CrossRepositoryTests(Executor):
    """Port can hold another repository's PR with the same number. The planner ignores it (it keys
    on the repository relation), so every later read must resolve the entity the same way."""

    def setUp(self):
        super().setUp()
        self.other = base.entity(559, relations={"repository": {"identifier": "Another-Repo"}},
                                 identifier="Another-Repo-pr-559")
        self.port = FakePort([stored_entity(559), self.other])

    def test_an_unrelated_entity_with_the_same_number_does_not_block_a_write(self):
        report = self.apply()
        self.assertEqual((report["result"], report["writes"], report["violations"]), ("written", 1, []))
        self.assertEqual(len(self.port.patches), 1)
        self.assertTrue(self.port.patches[0]["path"].endswith("/Retail-Tower-Erp-pr-559"))
        self.assertEqual(self.port.entities[1], self.other, "the other repository's entity is untouched")

    def test_such_an_entity_appearing_between_snapshot_and_write_does_not_block(self):
        self.port.entities.pop()
        self.port.hooks[("find_entities", 2)] = lambda p: p.entities.append(copy.deepcopy(self.other))
        self.assertEqual(self.apply()["result"], "written")

    def test_such_an_entity_changing_during_the_write_is_not_a_violation(self):
        self.port.hooks[("find_entities", 3)] = lambda p: p.entities[1]["properties"].update(status="closed")
        self.assertEqual(self.apply()["result"], "written")

    def test_the_best_effort_read_back_after_a_write_error_ignores_it(self):
        self.port.fail_patch = RuntimeError("down")
        self.assertIsNotNone(self.apply()["after"])

    def test_a_second_entity_of_this_repository_is_still_ambiguous(self):
        self.port.entities.append(stored_entity(559))
        report = self.go()
        self.assertEqual((report["result"], report["reasons"]), ("blocked", ["PORT_ENTITY_AMBIGUOUS"]))
        self.port.entities.pop()
        self.port.entities.pop(0)                                    # ours is gone, theirs remains
        self.assertEqual(self.go()["reasons"], ["PORT_ENTITY_MISSING"])


class VerificationTests(Executor):
    def assert_verify_failed(self, report, *violations):
        self.assertEqual(report["result"], "verify_failed")
        for violation in violations:
            self.assertIn(violation, report["violations"])
        self.assertEqual(len(self.port.patches), 1, "the executor never retries or rolls back by itself")
        ps.validate_request(report["rollback_request"])
        self.assertNotEqual(report["rollback_request"], self.port.patches[0])

    def test_a_write_that_did_not_take_effect_is_a_failure(self):
        self.port.apply_patch = False
        report = self.apply()
        self.assert_verify_failed(report, "WRITER_FIELDS_MISMATCH", "REPLAN_NOT_NOOP")
        self.assertEqual(report["writes"], 1)

    def test_a_write_that_clobbers_the_legacy_service_relation_is_a_failure(self):
        self.port.drop_service = True
        report = self.apply()
        self.assert_verify_failed(report, "PRESERVED_FIELDS_CHANGED")
        self.assertEqual(report["rollback_request"]["body"]["relations"], {"affected_services": []})

    def test_another_property_changing_during_the_write_is_a_failure(self):
        self.port.hooks[("find_entities", 3)] = lambda p: p.entities[0]["properties"].update(status="closed")
        self.assert_verify_failed(self.apply(), "PRESERVED_FIELDS_CHANGED")

    def test_the_entity_becoming_ambiguous_after_the_write_is_a_failure(self):
        self.port.hooks[("find_entities", 3)] = lambda p: p.entities.append(stored_entity(559))
        self.assert_verify_failed(self.apply(), "ENTITY_NOT_UNIQUE")

    def test_the_head_moving_after_the_write_is_a_failure(self):
        self.github.hooks[("get_pr", 3)] = lambda g: g.prs[559].update(head_sha=self.sha["f1"])
        self.assert_verify_failed(self.apply(), "STALE_HEAD_AFTER_WRITE")

    def test_a_failing_read_back_is_a_failure(self):
        self.port.break_find_after_patch = True
        report = self.apply()
        self.assert_verify_failed(report, "READBACK_FAILED")
        self.assertIsNone(report["after"])

    def test_the_rollback_restores_the_exact_previous_writer_values(self):
        before = {"attribution_scope": "single", "attribution_status": "classified",
                  "classification_policy_ref": "d" * 40,
                  "classification_evidence_url": f"{base.COMPARE}{OTHER40}...{HEAD40}"}
        self.port = FakePort([stored_entity(559, properties=before,
                                            relations={"affected_services": [{"identifier": "pos"}]})])
        self.port.apply_patch = False
        report = self.apply()
        rollback = report["rollback_request"]
        self.assertEqual(rollback["body"]["properties"], before)
        self.assertEqual(rollback["body"]["relations"], {"affected_services": ["pos"]})
        self.assertEqual(rollback["path"], report["request"]["path"])


class TransportErrorTests(Executor):
    def test_a_write_error_is_reported_once_and_never_retried(self):
        self.port.fail_patch = RuntimeError("TRANSPORT-TEXT-MUST-NOT-LEAK")
        report = self.apply()
        self.assertEqual((report["result"], report["reasons"], report["writes"]), ("error", ["PATCH_FAILED"], 1))
        self.assertEqual(self.port.counts["patch_entity"], 1)
        self.assertIsNotNone(report["rollback_request"])
        self.assertIsNotNone(report["after"])                   # best-effort read-back for diagnosis
        self.assertEqual(report["error_type"], "RuntimeError")
        self.assertNotIn("TRANSPORT-TEXT-MUST-NOT-LEAK", json.dumps(report))   # raw text may hold secrets

    def test_an_error_whose_read_back_also_fails_still_reports(self):
        self.port.fail_patch = RuntimeError("down")
        self.port.break_find_after_patch = True
        report = self.apply()
        self.assertEqual((report["result"], report["after"]), ("error", None))


class BoundaryTests(unittest.TestCase):
    SOURCE = pathlib.Path(pw.__file__).read_text(encoding="utf-8")

    def test_module_imports_only_the_standard_library_and_pgraph(self):
        roots = set()
        for node in ast.walk(ast.parse(self.SOURCE)):
            if isinstance(node, ast.Import):
                roots |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                roots.add("." if node.level else (node.module or "").split(".")[0])
        self.assertEqual(roots - {"."}, {"argparse", "copy", "hashlib", "json", "pathlib", "sys"})

    def test_module_has_no_network_credential_or_environment_access(self):
        for needle in ("import urllib", "import socket", "import http", "import requests", "import ssl",
                       "import subprocess", "import os", "os.environ", "environ", "getenv", "urlopen",
                       "PORT_CLIENT", "clientSecret", "client_secret", "access_token", "Authorization",
                       "Bearer"):
            self.assertNotIn(needle, self.SOURCE, needle)

    def test_writer_owned_fields_are_reused_not_redefined(self):
        self.assertIs(pw.port_sync, ps)
        self.assertNotIn("attribution_scope", self.SOURCE)
        self.assertNotIn("classification_policy_ref", self.SOURCE)
        self.assertNotIn('"service"', self.SOURCE)

    def test_the_snapshot_transport_cannot_write(self):
        port = pw.SnapshotPort([base.entity(559)], ["pos"])
        with self.assertRaises(ps.PlanError):
            port.patch_entity({"method": "PATCH"})


class CliTests(base.Scenario):
    def files(self, prs, entities, services=None):
        out = {}
        for name, data in (("prs", prs), ("entities", entities),
                           ("services", sorted(ps.SERVICES) if services is None else services)):
            out[name] = pathlib.Path(self.repo, f"{name}.json")
            out[name].write_text(json.dumps(data), encoding="utf-8")
        return out

    def argv(self, files, **overrides):
        args = {"--repo": self.repo, "--main-sha": self.tip, "--pr": "559", "--prs": str(files["prs"]),
                "--entities": str(files["entities"]), "--services": str(files["services"])}
        args.update(overrides)
        return ["dry-run"] + [x for pair in args.items() for x in pair]

    def test_dry_run_writes_a_report_and_exits_zero(self):
        files = self.files([base.pr(number=559, head_sha=self.sha["f2"])], [stored_entity(559)])
        out = pathlib.Path(self.repo, "report.json")
        self.assertEqual(pw.main(self.argv(files) + ["--out", str(out)]), 0)
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual((report["result"], report["writes"]), ("dry_run", 0))
        self.assertEqual(report["request"]["body"]["relations"], {"affected_services": ["backend-core", "pos"]})

    def test_a_blocked_dry_run_exits_two(self):
        files = self.files([base.pr(number=559, head_sha=self.sha["f2"])], [])
        out = pathlib.Path(self.repo, "blocked.json")
        self.assertEqual(pw.main(self.argv(files) + ["--out", str(out)]), 2)
        self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["reasons"], ["PORT_ENTITY_MISSING"])

    def test_there_is_no_apply_command_and_a_non_sha_tip_is_rejected(self):
        files = self.files([], [])
        with self.assertRaises(SystemExit):
            pw.main(["apply"] + self.argv(files)[1:])
        with self.assertRaises(SystemExit):
            pw.main(self.argv(files, **{"--main-sha": "main"}))
        with self.assertRaises(SystemExit):
            pw.main(self.argv(files, **{"--pr": "zero"}))


if __name__ == "__main__":
    unittest.main()
