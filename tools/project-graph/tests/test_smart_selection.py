"""RT-1173 (smart CI step 1): merge-base selection and shared classes that name jobs."""

import os
import subprocess
import tempfile
import unittest

import support
from pgraph import api_jest_select as ajs
from pgraph import evaluate as ev
from pgraph import gitio
from pgraph.cli import GRAPH_REPO_PATH, changes_for, proposed_graph
from pgraph.graph import Graph, load_graph, validate_graph


def _git(repo, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t.invalid")
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True,
                          env=env).stdout.decode().strip()


def _commit(repo, path, text, msg):
    full = os.path.join(repo, *path.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", newline="\n") as f:
        f.write(text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", msg)
    return _git(repo, "rev-parse", "HEAD")


class MergeBaseSelectionTests(unittest.TestCase):
    """A branch behind main is judged on its own changes only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        _git(self.repo, "init", "-q", "-b", "main")
        self.fork = _commit(self.repo, "apps/pos/src/a.ts", "a\n", "base")
        _git(self.repo, "checkout", "-q", "-b", "feature")
        self.head = _commit(self.repo, "apps/pos/src/b.ts", "b\n", "pr change")
        _git(self.repo, "checkout", "-q", "main")
        # main moves on after the branch point, in another product
        self.main = _commit(self.repo, "services/backend-core/apps/api/src/x.ts", "x\n", "main moves")

    def tearDown(self):
        self.tmp.cleanup()

    def test_stale_branch_selects_only_its_own_changes(self):
        base, changes = changes_for(self.repo, "pull_request", self.main, self.head)
        self.assertEqual(base, self.fork)
        self.assertEqual([c.path for c in changes], ["apps/pos/src/b.ts"])

    def test_two_dot_diff_would_have_charged_main(self):
        # the old behaviour, kept as the contrast this fix removes
        paths = {c.path for c in gitio.read_changes(self.repo, self.main, self.head)}
        self.assertIn("services/backend-core/apps/api/src/x.ts", paths)

    def test_clean_branch_is_unchanged(self):
        base, changes = changes_for(self.repo, "pull_request", self.fork, self.head)
        self.assertEqual(base, self.fork)
        self.assertEqual([c.path for c in changes], ["apps/pos/src/b.ts"])

    def test_push_event_keeps_the_given_base(self):
        base, changes = changes_for(self.repo, "push", self.main, self.main)
        self.assertEqual((base, changes), (self.main, ()))

    def test_unrelated_history_has_no_merge_base_and_fails_closed(self):
        _git(self.repo, "checkout", "-q", "--orphan", "lonely")
        other = _commit(self.repo, "README.md", "x\n", "unrelated")
        with self.assertRaises(gitio.DiffUnavailable):
            changes_for(self.repo, "pull_request", self.main, other)

    def test_main_changing_the_graph_is_not_the_stale_branchs_change(self):
        # reviewer finding: main edits graph.yaml after the fork; the branch only edits POS
        self.main = _commit(self.repo, GRAPH_REPO_PATH, "schema: main-v2\n", "main edits the graph")
        base, _ = changes_for(self.repo, "pull_request", self.main, self.head)
        trusted = gitio.read_text(self.repo, self.main, GRAPH_REPO_PATH)
        head_graph = gitio.read_text(self.repo, self.head, GRAPH_REPO_PATH)   # absent at the fork: None
        self.assertNotEqual(head_graph, trusted)
        self.assertIsNone(proposed_graph(self.repo, trusted, head_graph, base))

    def test_a_branch_that_edits_the_graph_still_proposes_it(self):
        _git(self.repo, "checkout", "-q", "feature")
        head = _commit(self.repo, GRAPH_REPO_PATH, "schema: pr-edit\n", "pr edits the graph")
        base, changes = changes_for(self.repo, "pull_request", self.main, head)
        self.assertIn(GRAPH_REPO_PATH, [c.path for c in changes])
        trusted = gitio.read_text(self.repo, self.main, GRAPH_REPO_PATH)
        self.assertEqual(proposed_graph(self.repo, trusted, "schema: pr-edit\n", base), "schema: pr-edit\n")

    def test_unresolvable_head_fails_closed(self):
        with self.assertRaises(gitio.DiffUnavailable):
            changes_for(self.repo, "pull_request", self.main, "f" * 40)


def _plan(path):
    return ev.evaluate(support.eval_input({"changes": [{"status": "M", "path": path}]}))


class NamedJobClassTests(unittest.TestCase):
    """Narrowed classes select exactly their list; everything else in policy still selects all."""

    def setUp(self):
        self.graph = Graph(load_graph(support.trusted_text()))
        self.always = set(self.graph.data["always_jobs"])

    def test_circleci_is_a_policy_change_that_selects_only_the_contracts_check(self):
        # contracts/check runs the .circleci/scripts offline specs
        plan = _plan(".circleci/config.yml")
        self.assertFalse(plan["select_all"])
        self.assertTrue(plan["policy_change"] and plan["approval_required"])
        self.assertEqual(set(plan["needed_jobs"]), self.always | {"contracts/check"})

    def test_release_tooling_class_selects_the_contracts_check(self):
        plan = _plan(".github/release/system_gate.py")
        self.assertFalse(plan["select_all"])
        self.assertTrue(plan["policy_change"])
        self.assertEqual(set(plan["needed_jobs"]), self.always | {"contracts/check"})

    def test_depot_is_a_policy_change_that_selects_only_the_contracts_check(self):
        # RT-1366: .depot/** is the opt-in Depot CI preflight; no mandatory job beyond the offline check
        for path in (".depot/workflows/preflight.yml", ".depot/scripts/patch-evidence.sh"):
            with self.subTest(path=path):
                plan = _plan(path)
                self.assertFalse(plan["select_all"])
                self.assertTrue(plan["policy_change"] and plan["approval_required"])
                self.assertEqual(set(plan["needed_jobs"]), self.always | {"contracts/check"})

    def test_system_manifest_class_selects_the_contracts_check_and_e2e_only(self):
        plan = _plan("system/releases/lab-2026.11.9.json")
        self.assertFalse(plan["select_all"])
        self.assertEqual(set(plan["needed_jobs"]),
                         self.always | {"contracts/check", self.graph.data["e2e_job"]})

    def test_other_policy_paths_still_select_all(self):
        for path in (".github/workflows/pos.yml", ".github/workflows/gate.yml", ".github/actions/x/action.yml",
                     "tools/project-graph/graph.yaml", "tools/ci-gate/x.md", "CODEOWNERS",
                     "apps/pos/.github/workflows/ci.yml"):
            with self.subTest(path=path):
                plan = _plan(path)
                self.assertTrue(plan["select_all"])
                self.assertEqual(set(plan["needed_jobs"]), self.graph.all_jobs)

    def test_compat_matrix_change_selects_the_contracts_check(self):
        # the release specs and the system gate (G5) in contracts/check parse this matrix
        plan = _plan("services/backend-core/contracts-compat/pos-supported.yaml")
        self.assertIn("contracts/check", plan["needed_jobs"])
        self.assertIn("bc/contracts-compat", plan["needed_jobs"])

    def test_classification_of_the_narrowed_paths(self):
        self.assertEqual(self.graph.classify(".circleci/scripts/x.cjs")[:2], ("class", "circleci"))
        self.assertEqual(self.graph.classify(".github/release/x.py")[:2], ("class", "release_tooling"))
        self.assertEqual(self.graph.classify(".github/release/sub/x.py")[:2], ("class", "release_tooling"))
        self.assertEqual(self.graph.classify(".github/releases.yml")[:2], ("class", "policy"))
        self.assertEqual(self.graph.classify(".depot/workflows/preflight.yml")[:2], ("class", "depot"))
        self.assertEqual(self.graph.classify(".depot/scripts/patch-evidence.sh")[:2], ("class", "depot"))
        self.assertEqual(self.graph.classify(".depotx/a.yml")[0], "unknown")

    def test_plan_reports_where_the_diff_starts(self):
        plan = _plan("apps/pos/src/a.ts")
        self.assertEqual(plan["diff_base"], plan["base_sha"])


class SchemaTests(unittest.TestCase):

    def test_a_class_may_name_graph_jobs(self):
        g = load_graph(support.trusted_text())
        g["shared_classes"]["docs"]["selects"] = ["bc/fast", "e2e"]
        self.assertNotIn("SCHEMA", {e.split(":", 1)[0] for e in validate_graph(g, workflow_jobs=dict(g["jobs"]))})

    def test_a_narrowed_policy_class_may_not_reach_a_product_root(self):
        g = load_graph(support.trusted_text())
        g["shared_classes"]["circleci"]["globs"] = [".circleci/**", "apps/pos/.circleci/**"]
        errs = validate_graph(g, workflow_jobs=dict(g["jobs"]))
        self.assertTrue(any(e.startswith("SHARED_GLOB_IN_PRODUCT: circleci") for e in errs), errs)

    def test_a_select_all_policy_class_may_still_reach_a_product_root(self):
        g = load_graph(support.trusted_text())
        self.assertIn("apps/*/.github/**", g["shared_classes"]["policy"]["globs"])
        errs = validate_graph(g, workflow_jobs=dict(g["jobs"]))
        self.assertFalse([e for e in errs if e.startswith("SHARED_GLOB_IN_PRODUCT")], errs)

    def test_an_unknown_job_name_is_rejected(self):
        g = load_graph(support.trusted_text())
        g["shared_classes"]["docs"]["selects"] = ["bc/nope"]
        self.assertIn("SCHEMA", {e.split(":", 1)[0] for e in validate_graph(g, workflow_jobs=dict(g["jobs"]))})


class ApiJestShadowTests(unittest.TestCase):
    """The RT-949 shadow selector reads a named-job class correctly."""

    def setUp(self):
        self.data = load_graph(support.trusted_text())

    def _verdict(self, selects):
        self.data["shared_classes"]["docs"]["selects"] = selects
        graph = Graph(self.data)
        return ajs._verdict(graph, ajs.fast_class(graph), ev.Change("M", "docs/x.md"))

    def test_class_naming_the_job_forces_full(self):
        self.assertEqual(self._verdict([ajs.JOB])[0], "full")

    def test_class_not_naming_the_job_is_ignored(self):
        self.assertEqual(self._verdict(["contracts/check"])[0], "ignore")
        self.assertEqual(self._verdict([])[0], "ignore")


if __name__ == "__main__":
    unittest.main()
