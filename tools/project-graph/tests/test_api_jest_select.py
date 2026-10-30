"""RT-949 Phase 1: the Backend-Core API Jest shadow selector (RT-946 c14579).

Every case that is not plainly "only ordinary API code or specs changed since a
trusted full-green run" must come out `full` (N1-N17). The selector only reports;
nothing here can change a job's result or `required`."""

import json
import os
import subprocess
import tempfile
import unittest

from pgraph import api_jest_select as sel
from pgraph.evaluate import Change
from pgraph.graph import Graph, load_graph, validate_graph

import support

BC = "services/backend-core/"
API_SRC = BC + "apps/api/src/reports/report.service.ts"
API_SPEC = BC + "apps/api/test/reports/report.spec.ts"
REPO = "Kemetra-Labs/Retail-Tower-Erp"
A = "a" * 40
B = "b" * 40
H = "c" * 40


def _graph(text=None):
    data = load_graph(text or support.trusted_text())
    return Graph(data)


def _m(path, status="M", mode="100644"):
    return Change(status, path, mode=mode)


class FastClassTests(unittest.TestCase):

    def test_real_graph_declares_a_valid_fast_class(self):
        data = load_graph(support.trusted_text())
        self.assertEqual(validate_graph(data), [])
        globs, excludes = sel.fast_class(Graph(data))
        self.assertTrue(globs and excludes)

    def test_graph_without_fast_class_is_full(self):
        data = load_graph(support.trusted_text())
        del data["products"]["backend-core"]["api_jest_fast"]
        s = sel.select(Graph(data), A, [_m(API_SRC)], [])
        self.assertEqual((s.mode, s.reason), ("full", "NO_FAST_CLASS"))

    def test_malformed_fast_class_fails_validation(self):
        data = load_graph(support.trusted_text())
        data["products"]["backend-core"]["api_jest_fast"] = {"globs": "apps/api/**"}
        self.assertTrue(any("api_jest_fast" in e for e in validate_graph(data)))
        data["products"]["backend-core"]["api_jest_fast"] = {"globs": ["../x/**"]}
        self.assertTrue(any("api_jest_fast" in e for e in validate_graph(data)))


class SelectTests(unittest.TestCase):

    def setUp(self):
        self.graph = _graph()

    def _mode(self, pr, base=(), anchor=A):
        return sel.select(self.graph, anchor, list(pr), list(base))

    def test_plain_api_source_is_fast(self):
        s = self._mode([_m(API_SRC)])
        self.assertEqual((s.mode, s.files), ("fast", (API_SRC,)))

    def test_spec_only_and_mixed_are_fast(self):
        self.assertEqual(self._mode([_m(API_SPEC, "A")]).files, (API_SPEC,))
        self.assertEqual(self._mode([_m(API_SPEC), _m(API_SRC)]).files, tuple(sorted((API_SPEC, API_SRC))))

    def test_other_products_and_docs_are_ignored(self):
        s = self._mode([_m(API_SRC), _m("apps/pos/src/renderer/x.ts"), _m("docs/notes.md")])
        self.assertEqual((s.mode, s.files), ("fast", (API_SRC,)))

    def _assert_full(self, change, reason_prefix, base=()):
        s = self._mode([_m(API_SRC), change] if change else [_m(API_SRC)], base)
        self.assertEqual(s.mode, "full", change)
        self.assertTrue(s.reason.startswith(reason_prefix), (s.reason, reason_prefix))
        self.assertEqual(s.files, ())

    # N1-N11: one per `full` row of the RT-946 c14579 matrix
    def test_n1_delete_or_rename(self):
        self._assert_full(_m(BC + "apps/api/src/reports/old.ts", "D"), "DELETE_OR_RENAME")
        self._assert_full(Change("R", BC + "apps/api/src/reports/new.ts", old_path=BC + "apps/api/src/reports/x.ts"),
                          "DELETE_OR_RENAME")

    def test_n2_non_ts_file_in_api(self):
        self._assert_full(_m(BC + "apps/api/test/reports/fixture.json"), "NOT_FAST_ELIGIBLE")
        self._assert_full(_m(BC + "apps/api/src/reports/query.sql"), "NOT_FAST_ELIGIBLE")

    def test_n3_test_helpers(self):
        self._assert_full(_m(BC + "apps/api/test/_helpers/postgres-container.ts"), "NOT_FAST_ELIGIBLE")
        self._assert_full(_m(BC + "apps/api/test/_helpers/x.spec.ts"), "NOT_FAST_ELIGIBLE")

    def test_n4_workspace_packages(self):
        self._assert_full(_m(BC + "packages/shared/src/util.ts"), "NOT_FAST_ELIGIBLE")

    def test_n5_migrations(self):
        self._assert_full(_m(BC + "packages/db/drizzle/0076_x.sql"), "TIER:migrations")

    def test_n6_tenant_auth(self):
        self._assert_full(_m(BC + "apps/api/src/auth/guard.ts"), "TIER:tenant-auth")

    def test_n7_money(self):
        self._assert_full(_m(BC + "apps/api/src/settlement/x.ts"), "TIER:money")

    def test_n8_sales_stock_posting(self):
        self._assert_full(_m(BC + "apps/api/src/catalog/sales/x.ts"), "TIER:sales")
        self._assert_full(_m(BC + "apps/api/src/inventory/x.ts"), "TIER:stock")
        self._assert_full(_m(BC + "apps/api/src/outbox/x.ts"), "TIER:posting-sync")

    def test_n9_contracts(self):
        self._assert_full(_m(BC + "apps/api/src/openapi/loader.ts"), "TIER:contracts")

    def test_n10_dependency_and_config(self):
        self._assert_full(_m(BC + "apps/api/package.json"), "TIER:dependency")
        self._assert_full(_m(BC + "apps/api/jest.config.cjs"), "NOT_FAST_ELIGIBLE")
        self._assert_full(_m(BC + "pnpm-lock.yaml"), "TIER:dependency")

    def test_n11_policy_tooling_root_unknown(self):
        self._assert_full(_m(".github/workflows/backend-core.yml"), "CLASS:policy")
        self._assert_full(_m("tools/contracts-check/x.py"), "CLASS:tooling")
        self._assert_full(_m("package.json"), "CLASS:root")
        self._assert_full(_m(BC + "apps/worker/src/x.ts"), "NOT_FAST_ELIGIBLE")

    def test_other_product_with_a_semantic_edge_to_this_job_is_full(self):
        data = load_graph(support.trusted_text())
        data["products"]["pos"]["tiers"]["money"]["jobs"].append("bc/db-integration")
        s = sel.select(Graph(data), A, [_m(API_SRC), _m("apps/pos/src/main/payments/x.ts")], [])
        self.assertEqual(s.mode, "full")
        self.assertTrue(s.reason.startswith("SEMANTIC_EDGE:pos"))

    def test_symlink_or_submodule_is_full(self):
        self._assert_full(_m(BC + "apps/api/src/reports/link.ts", mode="120000"), "SPECIAL_MODE")

    # N12, N14, N17
    def test_n12_no_anchor(self):
        s = self._mode([_m(API_SRC)], anchor=None)
        self.assertEqual((s.mode, s.reason), ("full", "NO_ANCHOR"))

    def test_n14_base_delta_touching_backend_core_is_full(self):
        s = self._mode([_m(API_SRC)], base=[_m(API_SPEC)])
        self.assertEqual(s.mode, "full")
        self.assertTrue(s.reason.startswith("BASE_MOVED"))
        s = self._mode([_m(API_SRC)], base=[_m(".github/workflows/gate.yml")])
        self.assertTrue(s.reason.startswith("BASE_MOVED"))

    def test_base_delta_outside_backend_core_is_fine(self):
        s = self._mode([_m(API_SRC)], base=[_m("apps/pos/src/renderer/x.ts"), _m("docs/a.md")])
        self.assertEqual(s.mode, "fast")

    def test_n17_no_files_is_full(self):
        self.assertEqual(self._mode([]).reason, "NO_FILES")
        self.assertEqual(self._mode([_m("apps/pos/src/renderer/x.ts")]).reason, "NO_FILES")

    def test_fast_never_has_zero_files(self):
        for pr in ([], [_m(API_SRC)], [_m(API_SPEC)], [_m("docs/a.md")]):
            s = self._mode(pr)
            self.assertTrue(s.mode == "full" or s.files, pr)


def _run(run_id, sha, event="pull_request", path=sel.WORKFLOW, base=B, repo=REPO):
    prs = [{"number": 7, "base": {"sha": base}}] if event == "pull_request" else []
    return {"id": run_id, "path": path, "event": event, "head_sha": sha, "status": "completed",
            "repository": {"full_name": repo}, "pull_requests": prs}


def _job(sha, check_id, conclusion="success", attempt=1, name=sel.JOB):
    return {"name": name, "run_attempt": attempt, "head_sha": sha, "status": "completed",
            "conclusion": conclusion, "check_run_url": f"https://api.github.com/repos/{REPO}/check-runs/{check_id}"}


def _evidence(runs, jobs, checks):
    return {"runs": runs, "jobs": {str(k): v for k, v in jobs.items()}, "checks": checks}


GH_APP = {"id": 15368}


class AnchorTests(unittest.TestCase):

    def setUp(self):
        self.data = load_graph(support.trusted_text())

    def _find(self, candidates, evidence):
        return sel.find_anchor(candidates, evidence, REPO, self.data, 7)

    def test_newest_full_green_pr_commit_is_the_anchor(self):
        ev = {H: _evidence([_run(2, H)], {2: [_job(H, 22, "failure")]}, [{"id": 22, "app": GH_APP}]),
              A: _evidence([_run(1, A)], {1: [_job(A, 11)]}, [{"id": 11, "app": GH_APP}])}
        self.assertEqual(self._find([(H, "pull_request"), (A, "pull_request")], ev), A)

    def test_merge_base_push_run_can_anchor(self):
        ev = {H: _evidence([], {}, []),
              A: _evidence([_run(1, A, "push")], {1: [_job(A, 11)]}, [{"id": 11, "app": GH_APP}])}
        self.assertEqual(self._find([(H, "pull_request"), (A, "push")], ev), A)

    def test_no_green_anywhere(self):
        ev = {H: _evidence([_run(2, H)], {2: [_job(H, 22, "cancelled")]}, [{"id": 22, "app": GH_APP}])}
        with self.assertRaisesRegex(sel.AnchorUnavailable, "NO_ANCHOR"):
            self._find([(H, "pull_request")], ev)

    # N15: untrusted or ambiguous evidence never anchors
    def test_n15_foreign_producer_workflow_event_or_repo_never_anchor(self):
        cases = [
            _evidence([_run(1, A)], {1: [_job(A, 11)]}, [{"id": 11, "app": {"id": 999}}]),
            _evidence([_run(1, A, path=".github/workflows/evil.yml")], {1: [_job(A, 11)]}, [{"id": 11, "app": GH_APP}]),
            _evidence([_run(1, A, event="push")], {1: [_job(A, 11)]}, [{"id": 11, "app": GH_APP}]),
            _evidence([_run(1, A, repo="evil/fork")], {1: [_job(A, 11)]}, [{"id": 11, "app": GH_APP}]),
        ]
        for ev in cases:
            with self.assertRaisesRegex(sel.AnchorUnavailable, "NO_ANCHOR"):
                self._find([(A, "pull_request")], {A: ev})

    def test_n15_latest_attempt_wins_and_duplicates_fail(self):
        ev = _evidence([_run(1, A)], {1: [_job(A, 11, "success", 1), _job(A, 12, "failure", 2)]},
                       [{"id": 11, "app": GH_APP}, {"id": 12, "app": GH_APP}])
        with self.assertRaisesRegex(sel.AnchorUnavailable, "NO_ANCHOR"):
            self._find([(A, "pull_request")], {A: ev})
        ev = _evidence([_run(1, A)], {1: [_job(A, 11), _job(A, 12)]},
                       [{"id": 11, "app": GH_APP}, {"id": 12, "app": GH_APP}])
        with self.assertRaisesRegex(sel.AnchorUnavailable, "ANCHOR_AMBIGUOUS"):
            self._find([(A, "pull_request")], {A: ev})

    def test_newer_red_run_on_the_same_commit_is_not_an_anchor(self):
        ev = _evidence([_run(1, A), _run(2, A)], {1: [_job(A, 11)], 2: [_job(A, 21, "failure")]},
                       [{"id": 11, "app": GH_APP}, {"id": 21, "app": GH_APP}])
        with self.assertRaisesRegex(sel.AnchorUnavailable, "NO_ANCHOR"):
            self._find([(A, "pull_request")], {A: ev})

    def test_green_run_of_another_pr_is_not_an_anchor(self):
        run = _run(1, A)
        run["pull_requests"] = [{"number": 99, "base": {"sha": B}}]
        ev = _evidence([run], {1: [_job(A, 11)]}, [{"id": 11, "app": GH_APP}])
        with self.assertRaisesRegex(sel.AnchorUnavailable, "NO_ANCHOR"):
            self._find([(A, "pull_request")], {A: ev})
        run["pull_requests"] = []
        with self.assertRaisesRegex(sel.AnchorUnavailable, "NO_ANCHOR"):
            self._find([(A, "pull_request")], {A: ev})

    def test_n16_missing_or_failed_evidence(self):
        with self.assertRaisesRegex(sel.AnchorUnavailable, "EVIDENCE_UNAVAILABLE"):
            self._find([(A, "pull_request")], {})
        with self.assertRaisesRegex(sel.AnchorUnavailable, "EVIDENCE_UNAVAILABLE"):
            self._find([(A, "pull_request")], {A: {"error": "HTTP 502"}})


def _git(repo, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t.invalid")
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True,
                          env=env).stdout.decode().strip()


class SelectFromRepoTests(unittest.TestCase):
    """The CLI path: trusted graph read from the base rev, diffs read with git plumbing."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        _git(self.repo, "init", "-q", "-b", "main")
        self._write("tools/project-graph/graph.yaml", support.trusted_text())
        self._write(API_SRC, "export const a = 1;\n")
        self.base = self._commit("base")

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, path, text):
        full = os.path.join(self.repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)

    def _commit(self, msg):
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", msg)
        return _git(self.repo, "rev-parse", "HEAD")

    def _evidence_for(self, sha, event="pull_request", base=None):
        return {sha: _evidence([_run(1, sha, event, base=base or self.base)], {1: [_job(sha, 11)]},
                               [{"id": 11, "app": GH_APP}])}

    def test_spec_push_after_a_green_anchor_is_fast(self):
        _git(self.repo, "checkout", "-q", "-b", "pr")
        self._write(API_SRC, "export const a = 2;\n")
        anchor = self._commit("feature")
        self._write(API_SPEC, "it('x', () => {});\n")
        head = self._commit("review fix")
        evidence = {head: _evidence([], {}, []), **self._evidence_for(anchor)}
        s = sel.select_from_repo(self.repo, self.base, head, "pull_request",
                                 [(head, "pull_request"), (anchor, "pull_request")], evidence, REPO, 7)
        self.assertEqual((s.mode, s.anchor, s.files), ("fast", anchor, (API_SPEC,)))

    def test_n13_anchor_not_an_ancestor_is_full(self):
        _git(self.repo, "checkout", "-q", "-b", "old")
        self._write(API_SRC, "export const a = 3;\n")
        orphan = self._commit("rewritten away")
        _git(self.repo, "checkout", "-q", "main")
        _git(self.repo, "checkout", "-q", "-b", "pr")
        self._write(API_SPEC, "it('y', () => {});\n")
        head = self._commit("force-pushed")
        s = sel.select_from_repo(self.repo, self.base, head, "pull_request",
                                 [(orphan, "pull_request")], self._evidence_for(orphan), REPO, 7)
        self.assertEqual((s.mode, s.reason), ("full", "ANCHOR_NOT_ANCESTOR"))

    def test_base_moved_with_backend_core_change_is_full(self):
        _git(self.repo, "checkout", "-q", "-b", "pr")
        self._write(API_SPEC, "it('z', () => {});\n")
        anchor = self._commit("feature")
        head = anchor
        _git(self.repo, "checkout", "-q", "main")
        self._write(BC + "apps/api/src/reports/other.ts", "export const o = 1;\n")
        new_base = self._commit("main moved")
        s = sel.select_from_repo(self.repo, new_base, head, "pull_request",
                                 [(head, "pull_request")], self._evidence_for(anchor, base=self.base), REPO, 7)
        self.assertEqual(s.mode, "full")
        self.assertTrue(s.reason.startswith("BASE_MOVED"))

    def test_missing_pr_number_is_full(self):
        s = sel.select_from_repo(self.repo, self.base, self.base, "pull_request", [], {}, REPO, None)
        self.assertEqual((s.mode, s.reason), ("full", "NO_PR_NUMBER"))

    def test_push_event_and_unreadable_graph_are_full(self):
        s = sel.select_from_repo(self.repo, self.base, self.base, "push", [], {}, REPO, 7)
        self.assertEqual((s.mode, s.reason), ("full", "PUSH_EVENT"))
        self._write("tools/project-graph/graph.yaml", "schema: broken\n")
        broken = self._commit("broken graph")
        s = sel.select_from_repo(self.repo, broken, broken, "pull_request", [], {}, REPO, 7)
        self.assertEqual((s.mode, s.reason), ("full", "TRUSTED_GRAPH_INVALID"))


class EvidenceDirTests(unittest.TestCase):
    """The workflow writes REST dumps as files; anything missing must read as an error."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _dump(self, rel, obj):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def test_complete_and_incomplete_candidates(self):
        from pgraph.cli import _load_evidence_dir
        self._dump("candidates.json", [{"sha": A, "event": "pull_request"}, {"sha": H, "event": "push"},
                                       {"sha": "not-a-sha", "event": "push"}])
        self._dump(f"{A}/runs.json", [_run(1, A)])
        self._dump(f"{A}/checks.json", [{"id": 11, "app": GH_APP}])
        self._dump(f"{A}/job-1.json", [_job(A, 11)])
        self._dump(f"{H}/runs.json", [_run(2, H, "push")])
        self._dump(f"{H}/checks.json", [])
        candidates, evidence = _load_evidence_dir(self.root)
        self.assertEqual(candidates, [(A, "pull_request"), (H, "push")])
        self.assertEqual(sorted(evidence[A]), ["checks", "jobs", "runs"])
        self.assertEqual(evidence[H], {"error": "jobs"})
        self.assertEqual(sel.find_anchor(candidates, evidence, REPO, load_graph(support.trusted_text()), 7), A)

    def test_missing_runs_file_is_an_error(self):
        from pgraph.cli import _load_evidence_dir
        self._dump("candidates.json", [{"sha": A, "event": "pull_request"}])
        self._dump(f"{A}/checks.json", [])
        _, evidence = _load_evidence_dir(self.root)
        self.assertEqual(evidence[A], {"error": "unreadable"})


class ReportTests(unittest.TestCase):

    def _results(self, failing, passing=()):
        return {"testResults": [{"name": n, "status": "failed"} for n in failing]
                + [{"name": n, "status": "passed"} for n in passing]}

    def test_fast_report_counts_misses(self):
        r = sel.report({"mode": "fast", "reason": "OK", "anchor": A, "files": [API_SRC]},
                       ["/w/a.spec.ts"], 683, self._results(["/w/a.spec.ts", "/w/b.spec.ts"]))
        self.assertEqual((r["selected"], r["total"], r["failing"], r["misses"]), (1, 683, 2, ["/w/b.spec.ts"]))

    def test_full_report_has_no_miss_claim(self):
        r = sel.report({"mode": "full", "reason": "NO_ANCHOR"}, [], 683, self._results(["/w/b.spec.ts"]))
        self.assertIsNone(r["misses"])
        self.assertEqual(r["failing"], 1)

    def test_fast_with_empty_list_is_flagged(self):
        r = sel.report({"mode": "fast", "reason": "OK", "anchor": A, "files": [API_SRC]}, [], 683,
                       self._results([]))
        self.assertEqual(r["flag"], "EMPTY_SELECTION")
        self.assertIsNone(r["misses"])

    def test_missing_results_never_claims_zero_misses(self):
        r = sel.report({"mode": "fast", "reason": "OK", "anchor": A, "files": [API_SRC]}, ["/w/a.spec.ts"],
                       683, None)
        self.assertIsNone(r["misses"])
        self.assertEqual(r["flag"], "NO_RESULTS")

    def test_report_is_json_serialisable(self):
        r = sel.report({"mode": "full", "reason": "PUSH_EVENT"}, [], 0, None)
        json.dumps(r, ensure_ascii=True)


if __name__ == "__main__":
    unittest.main()
