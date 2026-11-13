"""Phase-4 S1: offline Port sync planning. No network, no Port credentials, no writes.

Real temporary Git repositories prove the evidence rules for open, squash-merged,
merge-commit-merged and rebase-merged pull requests."""

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from pgraph import port_sync as ps
from pgraph.graph import load_graph

import support

HEAD40 = "a" * 40
OTHER40 = "b" * 40
REPO = ps.REPOSITORY
COMPARE = f"https://github.com/{REPO}/compare/"


REPO_LOCATION_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                      "GIT_COMMON_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES")


def git(repo, *args):
    env = {k: v for k, v in os.environ.items() if k not in REPO_LOCATION_VARS}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t.invalid")
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True,
                          env=env).stdout.decode().strip()


def write(repo, rel, text):
    path = pathlib.Path(repo, *rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def copy_into(repo, rel, source):
    """Copy a real file into the temp repo without reading it into a string."""
    path = pathlib.Path(repo, *rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, path)


def pr(**overrides):
    base = {"number": 559, "state": "open", "merged": False, "base_ref": "main",
            "head_sha": HEAD40, "head_repo": REPO, "merge_commit_sha": None}
    base.update(overrides)
    return base


def entity(number=559, **overrides):
    props = {"prNumber": number, "status": "open", "attribution_scope": None,
             "attribution_status": None, "classification_policy_ref": None,
             "classification_evidence_url": None}
    props.update(overrides.pop("properties", {}))
    relations = {"repository": {"identifier": ps.REPO_NAME, "title": ps.REPO_NAME},
                 "service": None, "affected_services": []}
    relations.update(overrides.pop("relations", {}))
    return {"identifier": f"{ps.REPO_NAME}-pr-{number}", "properties": props,
            "relations": relations, **overrides}


def build_repo(repo):
    """main: c0 -> c1(docs).  feature (from c0): f1 backend-core, f2 pos."""
    git(repo, "init", "-q", "-b", "main")
    copy_into(repo, "tools/project-graph/graph.yaml", support.GRAPH_PATH)
    write(repo, "tools/project-graph/pgraph/classifier.py", "VERSION = 1\n")
    write(repo, "apps/pos/src/a.ts", "export const a = 1;\n")
    write(repo, "services/backend-core/src/b.ts", "export const b = 1;\n")
    write(repo, "docs/x.md", "x\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    c0 = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "-b", "feature")
    write(repo, "services/backend-core/src/b.ts", "export const b = 2;\n")
    git(repo, "commit", "-aq", "-m", "f1 backend")
    f1 = git(repo, "rev-parse", "HEAD")
    write(repo, "apps/pos/src/a.ts", "export const a = 2;\n")
    git(repo, "commit", "-aq", "-m", "f2 pos")
    f2 = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "main")
    write(repo, "docs/x.md", "y\n")
    git(repo, "commit", "-aq", "-m", "c1 docs")
    c1 = git(repo, "rev-parse", "HEAD")
    return {"c0": c0, "f1": f1, "f2": f2, "c1": c1}


class Scenario(unittest.TestCase):
    def setUp(self):
        # Planner calls go through gitio._git, which inherits this process environment (for example
        # GIT_DIR from a Git hook): scrub it for the whole scenario so only the temp repo is used.
        patcher = patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in REPO_LOCATION_VARS:
            os.environ.pop(name, None)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmp.cleanup)
        self.repo = self.tmp.name
        self.sha = build_repo(self.repo)
        self.tip = self.sha["c1"]

    def tip_now(self):
        return git(self.repo, "rev-parse", "main")


class PolicyRefTests(Scenario):
    def test_ref_is_last_commit_touching_graph_or_classifier_code(self):
        self.assertEqual(ps.policy_ref(self.repo, self.tip), self.sha["c0"])
        write(self.repo, "docs/x.md", "z\n")
        git(self.repo, "commit", "-aq", "-m", "docs only")
        self.assertEqual(ps.policy_ref(self.repo, self.tip_now()), self.sha["c0"])
        write(self.repo, "tools/project-graph/pgraph/classifier.py", "VERSION = 2\n")
        git(self.repo, "commit", "-aq", "-m", "classifier fix")
        fixed = self.tip_now()
        self.assertEqual(ps.policy_ref(self.repo, fixed), fixed)

    def test_ref_tree_and_graph_blob_equal_the_trusted_tip(self):
        write(self.repo, "docs/x.md", "z\n")
        git(self.repo, "commit", "-aq", "-m", "docs only")
        tip = self.tip_now()
        ref = ps.policy_ref(self.repo, tip)
        for path in ("tools/project-graph/graph.yaml", "tools/project-graph/pgraph"):
            self.assertEqual(git(self.repo, "rev-parse", f"{ref}:{path}"),
                             git(self.repo, "rev-parse", f"{tip}:{path}"))

    def test_unresolvable_tip_or_invalid_sha_is_none(self):
        self.assertIsNone(ps.policy_ref(self.repo, "f" * 40))
        self.assertIsNone(ps.policy_ref(self.repo, "main"))


class EvidenceTests(Scenario):
    def merged(self, merge_commit):
        return pr(state="closed", merged=True, head_sha=self.sha["f2"], merge_commit_sha=merge_commit)

    def test_open_pr_uses_main_tip_and_classifies_the_whole_branch(self):
        out = ps.classify_pr(self.repo, pr(head_sha=self.sha["f2"]), self.tip)
        self.assertEqual(out["outcome"], "classified")
        self.assertEqual(out["basis"], "pr_head")
        self.assertEqual(out["services"], ["backend-core", "pos"])
        self.assertEqual(out["diff_base"], self.sha["c0"])

    def test_squash_merged_pr_still_uses_head_against_main_tip(self):
        git(self.repo, "merge", "--squash", "-q", "feature")
        git(self.repo, "commit", "-q", "-m", "squash")
        squash = self.tip_now()
        out = ps.classify_pr(self.repo, self.merged(squash), squash)
        self.assertEqual((out["outcome"], out["basis"]), ("classified", "pr_head"))
        self.assertEqual(out["services"], ["backend-core", "pos"])

    def test_rebase_merge_is_not_reduced_to_the_last_replayed_commit(self):
        git(self.repo, "cherry-pick", self.sha["f1"], self.sha["f2"])
        last = self.tip_now()
        landed_only_last = git(self.repo, "diff", "--name-only", f"{last}^", last)
        self.assertEqual(landed_only_last, "apps/pos/src/a.ts")      # the trap this test guards
        with patch.object(ps.port_attribution, "classify_git",
                          wraps=ps.port_attribution.classify_git) as spy:
            out = ps.classify_pr(self.repo, self.merged(last), last)
        # Head against the trusted tip: the policy graph is read from the tip, never from a commit
        # that already contains replayed PR changes.
        spy.assert_called_once_with(self.repo, last, self.sha["f2"], 559)
        self.assertEqual(out["outcome"], "classified")
        self.assertEqual(out["services"], ["backend-core", "pos"])

    def test_merge_commit_merge_uses_first_parent_when_second_parent_is_the_head(self):
        git(self.repo, "merge", "--no-ff", "-q", "-m", "merge", "feature")
        merge = self.tip_now()
        out = ps.classify_pr(self.repo, self.merged(merge), merge)
        self.assertEqual((out["outcome"], out["basis"]), ("classified", "merge_first_parent"))
        self.assertEqual(out["services"], ["backend-core", "pos"])

    def test_merge_commit_whose_second_parent_is_not_the_head_fails_closed(self):
        git(self.repo, "merge", "--no-ff", "-q", "-m", "merge", "feature")
        merge = self.tip_now()
        bad = pr(state="closed", merged=True, head_sha=self.sha["f1"], merge_commit_sha=merge)
        out = ps.classify_pr(self.repo, bad, merge)
        self.assertEqual(out["outcome"], "insufficient")
        self.assertEqual(out["services"], [])
        self.assertIn("HEAD_ALREADY_IN_BASE", out["reasons"])

    def test_open_pr_whose_head_is_already_in_main_gives_insufficient_evidence(self):
        out = ps.classify_pr(self.repo, pr(head_sha=self.sha["c0"]), self.tip)
        self.assertEqual(out["outcome"], "insufficient")
        self.assertIn("HEAD_ALREADY_IN_BASE", out["reasons"])

    def test_non_main_base_and_foreign_head_repo_are_deterministic_refusals(self):
        stacked = ps.classify_pr(self.repo, pr(head_sha=self.sha["f2"], base_ref="feature"), self.tip)
        self.assertEqual((stacked["outcome"], stacked["reasons"]), ("insufficient", ["NON_MAIN_BASE"]))
        fork = ps.classify_pr(self.repo, pr(head_sha=self.sha["f2"], head_repo="someone/fork"), self.tip)
        self.assertEqual((fork["outcome"], fork["reasons"]), ("insufficient", ["FOREIGN_HEAD_REPO"]))

    def test_missing_objects_and_bad_snapshots_are_infrastructure_not_a_verdict(self):
        for snapshot in (pr(head_sha="f" * 40), pr(head_sha="short"), pr(number=0), pr(number=True),
                         {"number": 1}):
            with self.subTest(snapshot=snapshot):
                out = ps.classify_pr(self.repo, snapshot, self.tip)
                self.assertEqual(out["outcome"], "infra")
                self.assertEqual(out["services"], [])
        self.assertEqual(ps.classify_pr(self.repo, pr(head_sha=self.sha["f2"]), "f" * 40)["outcome"], "infra")

    def test_classifier_environment_failures_are_infrastructure_not_a_verdict(self):
        for reason in sorted(ps.INFRA_REASONS):
            with self.subTest(reason=reason):
                failed = {"attribution_status": "insufficient_evidence", "reason_codes": [reason]}
                with patch.object(ps.port_attribution, "classify_git", return_value=failed):
                    out = ps.classify_pr(self.repo, pr(head_sha=self.sha["f2"]), self.tip)
                self.assertEqual((out["outcome"], out["services"]), ("infra", []))

    def test_unknown_path_in_the_diff_is_a_deterministic_insufficient_result(self):
        git(self.repo, "checkout", "-q", "feature")
        write(self.repo, "brand-new-root/x.py", "x\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "unknown")
        head = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", "main")
        out = ps.classify_pr(self.repo, pr(head_sha=head), self.tip)
        self.assertEqual(out["outcome"], "insufficient")
        self.assertIn("UNKNOWN_PATH", out["reasons"])
        self.assertEqual(out["services"], [])


class DesiredStateTests(unittest.TestCase):
    def outcome(self, services, scope, diff_base=OTHER40):
        return {"outcome": "classified", "services": services, "scope": scope, "shared": [],
                "diff_base": diff_base, "head_sha": HEAD40, "basis": "pr_head", "reasons": []}

    def test_classified_multi_is_sorted_and_commit_bound(self):
        d = ps.desired_state(self.outcome(["pos", "admin-console", "backend-core"], "multi"), "c" * 40)
        self.assertEqual(d["relations"]["affected_services"], ["admin-console", "backend-core", "pos"])
        self.assertEqual(d["properties"], {
            "attribution_scope": "multi", "attribution_status": "classified",
            "classification_policy_ref": "c" * 40,
            "classification_evidence_url": f"{COMPARE}{OTHER40}...{HEAD40}"})

    def test_shared_only_is_classified_with_an_empty_list(self):
        d = ps.desired_state(self.outcome([], "shared"), "c" * 40)
        self.assertEqual(d["properties"]["attribution_status"], "classified")
        self.assertEqual(d["relations"]["affected_services"], [])

    def test_insufficient_clears_the_list_and_never_names_a_service(self):
        d = ps.desired_state({"outcome": "insufficient", "services": ["pos"], "reasons": ["UNKNOWN_PATH"]}, "c" * 40)
        self.assertEqual(d["relations"]["affected_services"], [])
        self.assertEqual(d["properties"]["attribution_status"], "insufficient_evidence")
        self.assertEqual(d["properties"]["attribution_scope"], "unknown")
        self.assertIsNone(d["properties"]["classification_evidence_url"])

    def test_infra_has_no_desired_state(self):
        self.assertIsNone(ps.desired_state({"outcome": "infra", "services": [], "reasons": ["X"]}, "c" * 40))

    def test_unknown_service_in_a_classified_result_is_rejected(self):
        with self.assertRaises(ps.PlanError):
            ps.desired_state(self.outcome(["pos", "mystery"], "multi"), "c" * 40)

    def test_evidence_url_rejects_non_sha_input(self):
        self.assertIsNone(ps.evidence_url("main", HEAD40))
        self.assertIsNone(ps.evidence_url(HEAD40, None))
        self.assertEqual(ps.parse_evidence_head(f"{COMPARE}{OTHER40}...{HEAD40}"), HEAD40)
        for junk in (None, "", "https://evil.example/compare/x...y", f"{COMPARE}{OTHER40}..{HEAD40}",
                     f"{COMPARE}{OTHER40}...{HEAD40}/extra"):
            self.assertIsNone(ps.parse_evidence_head(junk))


class FindEntityTests(unittest.TestCase):
    def test_exact_match_by_number_repository_and_identifier(self):
        found, problem = ps.find_entity([entity(559), entity(560)], 559)
        self.assertEqual(found["identifier"], "Retail-Tower-Erp-pr-559")
        self.assertIsNone(problem)

    def test_missing_ambiguous_and_mismatched_identifiers_never_match(self):
        self.assertEqual(ps.find_entity([entity(560)], 559), (None, "PORT_ENTITY_MISSING"))
        self.assertEqual(ps.find_entity([entity(559), entity(559)], 559), (None, "PORT_ENTITY_AMBIGUOUS"))
        forked = entity(559)
        forked["identifier"] = "fork-pr-559"
        self.assertEqual(ps.find_entity([forked], 559), (None, "PORT_IDENTIFIER_MISMATCH"))
        other_repo = entity(559, relations={"repository": "Another-Repo"})
        self.assertEqual(ps.find_entity([other_repo], 559), (None, "PORT_ENTITY_MISSING"))

    def test_relation_values_may_be_a_string_dict_or_list(self):
        for value in ("Retail-Tower-Erp", {"identifier": "Retail-Tower-Erp"}, ["Retail-Tower-Erp"]):
            with self.subTest(value=value):
                found, problem = ps.find_entity([entity(559, relations={"repository": value})], 559)
                self.assertIsNone(problem)


class PlanTests(unittest.TestCase):
    SERVICES = frozenset(ps.SERVICES)

    def classified(self, services=("pos",), head=HEAD40):
        return {"outcome": "classified", "services": list(services),
                "scope": "single" if len(services) == 1 else "multi", "shared": [],
                "diff_base": OTHER40, "head_sha": head, "basis": "pr_head", "reasons": []}

    def stored_for(self, head, services=("pos",), **props):
        base = {"attribution_scope": "single", "attribution_status": "classified",
                "classification_policy_ref": "c" * 40,
                "classification_evidence_url": f"{COMPARE}{OTHER40}...{head}"}
        base.update(props)
        return entity(properties=base, relations={"affected_services": list(services)})

    def plan(self, snapshot, outcome, ent, services=None):
        return ps.plan_pr(snapshot, outcome, "c" * 40, ent, self.SERVICES if services is None else services)

    def test_unattributed_entity_gets_one_exact_partial_patch(self):
        item = self.plan(pr(), self.classified(("pos", "backend-core")), entity())
        self.assertEqual(item["action"], "patch")
        request = item["request"]
        self.assertEqual(request["method"], "PATCH")
        self.assertEqual(request["path"], "/v1/blueprints/githubPullRequest/entities/Retail-Tower-Erp-pr-559")
        self.assertEqual(request["query"], {"create_missing_related_entities": "false"})
        self.assertEqual(sorted(request["body"]), ["properties", "relations"])
        self.assertEqual(request["body"]["relations"], {"affected_services": ["backend-core", "pos"]})
        self.assertNotIn("service", request["body"]["relations"])
        self.assertEqual(sorted(request["body"]["properties"]), sorted(ps.WRITER_PROPERTIES))

    def test_equal_state_is_a_noop_and_null_equals_empty_list(self):
        same = self.plan(pr(), self.classified(), self.stored_for(HEAD40))
        self.assertEqual((same["action"], same["reason"]), ("noop", "UP_TO_DATE"))
        shared = {"outcome": "classified", "services": [], "scope": "shared", "shared": ["policy"],
                  "diff_base": OTHER40, "head_sha": HEAD40, "basis": "pr_head", "reasons": []}
        stored = self.stored_for(HEAD40, services=(), attribution_scope="shared")
        stored["relations"]["affected_services"] = None
        self.assertEqual(self.plan(pr(), shared, stored)["action"], "noop")

    def test_missing_service_entity_blocks_the_whole_write(self):
        item = self.plan(pr(), self.classified(("pos", "backend-core")), entity(),
                         services=frozenset({"pos"}))
        self.assertEqual((item["action"], item["reason"]), ("skip", "PORT_SERVICE_MISSING"))
        self.assertIsNone(item["request"])

    def test_deterministic_insufficient_writes_insufficient_and_empty(self):
        item = self.plan(pr(), {"outcome": "insufficient", "services": [], "reasons": ["UNKNOWN_PATH"]},
                         self.stored_for(HEAD40))
        self.assertEqual(item["action"], "patch")
        body = item["request"]["body"]
        self.assertEqual(body["relations"], {"affected_services": []})
        self.assertEqual(body["properties"]["attribution_status"], "insufficient_evidence")

    def test_infra_failure_keeps_a_value_that_is_still_for_the_current_head(self):
        item = self.plan(pr(), {"outcome": "infra", "services": [], "reasons": ["HEAD_OBJECT_MISSING"]},
                         self.stored_for(HEAD40))
        self.assertEqual((item["action"], item["reason"]), ("noop", "INFRA_KEEP_CURRENT"))

    def test_infra_failure_after_the_head_moved_writes_pending_and_empty(self):
        moved = pr(head_sha=OTHER40)
        item = self.plan(moved, {"outcome": "infra", "services": [], "reasons": ["HEAD_OBJECT_MISSING"]},
                         self.stored_for(HEAD40, services=("pos",)))
        self.assertEqual(item["action"], "patch")
        body = item["request"]["body"]
        self.assertEqual(body["properties"], {"attribution_scope": "unknown", "attribution_status": "pending",
                                              "classification_policy_ref": None,
                                              "classification_evidence_url": None})
        self.assertEqual(body["relations"], {"affected_services": []})

    def test_infra_failure_for_a_never_attributed_entity_writes_nothing(self):
        item = self.plan(pr(), {"outcome": "infra", "services": [], "reasons": ["X"]}, entity())
        self.assertEqual((item["action"], item["reason"]), ("noop", "INFRA_NOT_YET_ATTRIBUTED"))

    def test_merged_pr_classified_for_its_final_head_is_frozen(self):
        merged = pr(state="closed", merged=True, merge_commit_sha=OTHER40)
        newer_policy = ps.plan_pr(merged, self.classified(("pos", "backend-core")), "d" * 40,
                                  self.stored_for(HEAD40), self.SERVICES)
        self.assertEqual((newer_policy["action"], newer_policy["reason"]), ("noop", "FROZEN_MERGED"))

    def test_merged_pr_classified_for_an_older_head_is_recomputed(self):
        merged = pr(state="closed", merged=True, head_sha=OTHER40, merge_commit_sha=OTHER40)
        item = self.plan(merged, self.classified(("pos",), head=OTHER40), self.stored_for(HEAD40))
        self.assertEqual(item["action"], "patch")

    def test_open_pr_is_never_frozen(self):
        item = ps.plan_pr(pr(), self.classified(("pos", "backend-core")), "d" * 40,
                          self.stored_for(HEAD40), self.SERVICES)
        self.assertEqual(item["action"], "patch")

    def test_stale_head_check(self):
        item = self.plan(pr(), self.classified(), entity())
        self.assertFalse(ps.is_stale(item, HEAD40))
        self.assertTrue(ps.is_stale(item, OTHER40))
        self.assertTrue(ps.is_stale(item, "not-a-sha"))


class RequestValidationTests(unittest.TestCase):
    def good(self):
        return ps.build_request("Retail-Tower-Erp-pr-559", {
            "properties": {k: None for k in ps.WRITER_PROPERTIES},
            "relations": {"affected_services": ["pos"]}})

    def test_valid_request_passes(self):
        ps.validate_request(self.good())

    def test_every_forbidden_shape_is_rejected(self):
        cases = {}
        for label, mutate in {
            "legacy service relation": lambda r: r["body"]["relations"].update(service="pos"),
            "another relation": lambda r: r["body"]["relations"].update(repository="x"),
            "unknown property": lambda r: r["body"]["properties"].update(title="x"),
            "metadata property": lambda r: r["body"]["properties"].update(status="merged"),
            "unknown service": lambda r: r["body"]["relations"].update(affected_services=["pos", "x"]),
            "non-list relation": lambda r: r["body"]["relations"].update(affected_services="pos"),
            "create missing on": lambda r: r["query"].update(create_missing_related_entities="true"),
            "create missing absent": lambda r: r["query"].clear(),
            "not a PATCH": lambda r: r.update(method="POST"),
            "wrong blueprint": lambda r: r.update(path="/v1/blueprints/service/entities/pos"),
            "identifier outside repo": lambda r: r.update(path="/v1/blueprints/githubPullRequest/entities/x-pr-1"),
            "title in body": lambda r: r["body"].update(title="x"),
        }.items():
            request = self.good()
            mutate(request)
            cases[label] = request
        for label, request in cases.items():
            with self.subTest(label):
                with self.assertRaises(ps.PlanError):
                    ps.validate_request(request)


class PlanAllAndCliTests(Scenario):
    def inputs(self):
        prs = [pr(number=559, head_sha=self.sha["f2"]),
               pr(number=560, head_sha=self.sha["f1"]),
               pr(number=561, head_sha=self.sha["f2"])]
        entities = [entity(559), entity(560)]          # 561 has no Port entity
        return prs, entities

    def test_plan_all_summarises_and_never_touches_unmatched_entities(self):
        prs, entities = self.inputs()
        plan = ps.plan_all(self.repo, prs, entities, self.tip, frozenset(ps.SERVICES))
        self.assertEqual(plan["schema"], ps.PLAN_SCHEMA)
        by_pr = {item["pr"]: item for item in plan["items"]}
        self.assertEqual(by_pr[559]["action"], "patch")
        self.assertEqual(by_pr[559]["request"]["body"]["relations"], {"affected_services": ["backend-core", "pos"]})
        self.assertEqual(by_pr[560]["request"]["body"]["relations"], {"affected_services": ["backend-core"]})
        self.assertEqual((by_pr[561]["action"], by_pr[561]["reason"]), ("skip", "PORT_ENTITY_MISSING"))
        self.assertEqual(plan["summary"], {"patch": 2, "noop": 0, "skip": 1})
        self.assertEqual(plan["policy_ref"], self.sha["c0"])

    def test_duplicate_pr_numbers_skip_every_copy_without_classifying_them(self):
        prs, entities = self.inputs()
        prs.append(dict(prs[0]))                    # pagination can return one PR twice
        with patch.object(ps, "classify_pr", wraps=ps.classify_pr) as spy:
            plan = ps.plan_all(self.repo, prs, entities, self.tip, frozenset(ps.SERVICES))
        copies = [i for i in plan["items"] if i["pr"] == 559]
        self.assertEqual(len(copies), 2)
        self.assertTrue(all((i["action"], i["reason"], i["request"]) == ("skip", "DUPLICATE_PR_SNAPSHOT", None)
                            for i in copies))
        self.assertEqual([call.args[1]["number"] for call in spy.call_args_list], [560])
        self.assertEqual(plan["summary"], {"patch": 1, "noop": 0, "skip": 3})

    def test_merge_first_parent_records_the_policy_ref_of_the_graph_it_was_read_from(self):
        git(self.repo, "merge", "--no-ff", "-q", "-m", "merge", "feature")
        merge = self.tip_now()
        write(self.repo, "tools/project-graph/pgraph/classifier.py", "VERSION = 2\n")
        git(self.repo, "commit", "-aq", "-m", "classifier fix after the merge")
        tip = self.tip_now()
        merged = pr(number=559, state="closed", merged=True, head_sha=self.sha["f2"], merge_commit_sha=merge)
        plan = ps.plan_all(self.repo, [merged], [entity(559)], tip, frozenset(ps.SERVICES))
        recorded = plan["items"][0]["desired"]["properties"]["classification_policy_ref"]
        self.assertEqual(recorded, ps.policy_ref(self.repo, self.sha["c1"]))   # graph read at the first parent
        self.assertNotEqual(recorded, ps.policy_ref(self.repo, tip))

    def test_unavailable_policy_ref_skips_everything(self):
        prs, entities = self.inputs()
        plan = ps.plan_all(self.repo, prs, entities, "f" * 40, frozenset(ps.SERVICES))
        self.assertTrue(all(i["action"] == "skip" and i["reason"] == "POLICY_REF_UNAVAILABLE"
                            for i in plan["items"]))

    def test_cli_is_offline_and_writes_the_plan_file(self):
        prs, entities = self.inputs()
        out = pathlib.Path(self.repo, "plan.json")
        files = {}
        for name, data in (("prs", prs), ("entities", entities), ("services", sorted(ps.SERVICES))):
            files[name] = pathlib.Path(self.repo, f"{name}.json")
            files[name].write_text(json.dumps(data), encoding="utf-8")
        code = ps.main(["plan", "--repo", self.repo, "--main-sha", self.tip, "--prs", str(files["prs"]),
                        "--entities", str(files["entities"]), "--services", str(files["services"]),
                        "--out", str(out)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["summary"]["patch"], 2)

    def test_cli_rejects_a_non_sha_main_tip(self):
        with self.assertRaises(SystemExit):
            ps.main(["plan", "--repo", self.repo, "--main-sha", "main", "--prs", "x", "--entities", "x",
                     "--services", "x"])


class BoundaryTests(unittest.TestCase):
    def test_service_allow_list_equals_the_trusted_graph_products(self):
        graph = load_graph(support.trusted_text())
        self.assertEqual(set(ps.SERVICES), set(graph["products"]))

    def test_module_has_no_network_or_credential_imports(self):
        source = pathlib.Path(ps.__file__).read_text(encoding="utf-8")
        for needle in ("import urllib", "import socket", "import http", "import requests", "import ssl",
                       "os.environ", "getenv", "PORT_CLIENT", "clientSecret"):
            self.assertNotIn(needle, source, needle)

    def test_writer_owned_names_are_exactly_the_existing_port_fields(self):
        self.assertEqual(ps.WRITER_PROPERTIES, ("attribution_scope", "attribution_status",
                                                "classification_policy_ref", "classification_evidence_url"))
        self.assertEqual(ps.WRITER_RELATION, "affected_services")
        self.assertEqual(ps.BLUEPRINT, "githubPullRequest")


if __name__ == "__main__":
    unittest.main()
