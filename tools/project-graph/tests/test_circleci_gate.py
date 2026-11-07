"""RT-1256: bc/db-integration verifies the CircleCI API Jest status instead of running API Jest.

Every case that is not plainly "the CircleCI app reported success for this exact head, from
main's CircleCI config, on an in-scope same-repo PR" must wait or fail, never pass."""

import contextlib
import io
import json
import pathlib
import re
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout

import yaml

import support
from pgraph import circleci_gate as cg
from pgraph import evaluate as ev
from pgraph.cli import main as cli_main

REPO_ROOT = support.PG_ROOT.parents[1]
H = "c" * 40
API = "services/backend-core/apps/api/src/reports/report.service.ts"


def _status(state, created, sid, creator_id=cg.CIRCLECI_BOT_ID, ctype="Bot",
            context=cg.CONTEXT, url="https://app.circleci.com/workflow/w/job/j"):
    return {"id": sid, "state": state, "context": context, "created_at": created, "target_url": url,
            "creator": {"id": creator_id, "type": ctype, "login": "circleci-app[bot]"}}


def _judge(statuses, paths=(API,), fork=False, cc=False, event="pull_request", late=False, head=H):
    return cg.judge(event, head, fork, cc, list(paths), statuses, late)


class VerdictTests(unittest.TestCase):

    def test_success_from_the_circleci_app_passes(self):
        r = _judge([_status("success", "2026-11-06T09:00:00Z", 1)])
        self.assertEqual(r["verdict"], cg.OK, r)

    def test_no_status_waits_then_fails_at_the_deadline(self):
        self.assertEqual(_judge([])["verdict"], cg.PENDING)
        r = _judge([], late=True)
        self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["ABSENT_STATUS"]))

    def test_pending_waits_then_fails_at_the_deadline(self):
        st = [_status("pending", "2026-11-06T09:00:00Z", 1)]
        self.assertEqual(_judge(st)["verdict"], cg.PENDING)
        self.assertEqual(_judge(st, late=True)["reasons"], ["STATUS_INCOMPLETE"])

    def test_failure_and_error_fail(self):
        for state in ("failure", "error"):
            r = _judge([_status(state, "2026-11-06T09:00:00Z", 1)])
            self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["CIRCLECI_" + state.upper()]))

    def test_unknown_state_fails(self):
        self.assertEqual(_judge([_status("weird", "2026-11-06T09:00:00Z", 1)])["verdict"], cg.FAIL)

    def test_the_newest_status_decides(self):
        old_ok = _status("success", "2026-11-06T09:00:00Z", 1)
        new_pending = _status("pending", "2026-11-06T09:05:00Z", 2)
        new_fail = _status("failure", "2026-11-06T09:05:00Z", 3)
        self.assertEqual(_judge([old_ok, new_pending])["verdict"], cg.PENDING)   # a re-run in flight
        self.assertEqual(_judge([new_fail, old_ok])["verdict"], cg.FAIL)
        old_fail = _status("failure", "2026-11-06T09:00:00Z", 4)
        new_ok = _status("success", "2026-11-06T09:10:00Z", 5)
        self.assertEqual(_judge([old_fail, new_ok])["verdict"], cg.OK)          # a green full re-run

    def test_same_timestamp_breaks_ties_by_status_id(self):
        a = _status("success", "2026-11-06T09:00:00Z", 10)
        b = _status("failure", "2026-11-06T09:00:00Z", 11)
        self.assertEqual(_judge([a, b])["verdict"], cg.FAIL)

    def test_a_status_from_anyone_else_never_counts(self):
        forged = [_status("success", "2026-11-06T09:00:00Z", 1, creator_id=1),
                  _status("success", "2026-11-06T09:00:00Z", 2, ctype="User"),
                  _status("success", "2026-11-06T09:00:00Z", 3, url="https://evil.example/x")]
        r = _judge(forged)
        self.assertEqual(r["verdict"], cg.PENDING)
        self.assertEqual(sorted(x["problem"] for x in r["rejected"]),
                         ["WRONG_CREATOR", "WRONG_CREATOR", "WRONG_TARGET"])
        # a forged success never outranks a real failure
        r = _judge(forged + [_status("failure", "2026-11-06T08:00:00Z", 4)])
        self.assertEqual(r["verdict"], cg.FAIL)

    def test_other_contexts_are_ignored(self):
        st = [_status("success", "2026-11-06T09:00:00Z", 1, context="ci/circleci: remote-api-jest"),
              _status("success", "2026-11-06T09:00:00Z", 2, context="ci/circleci: api-jest-gate-x")]
        self.assertEqual(_judge(st, late=True)["reasons"], ["ABSENT_STATUS"])

    def test_fork_config_change_and_wrong_event_fail_before_any_status(self):
        ok = [_status("success", "2026-11-06T09:00:00Z", 1)]
        self.assertEqual(_judge(ok, fork=True)["reasons"], ["FORK_PR"])
        self.assertEqual(_judge(ok, cc=True)["reasons"], ["CIRCLECI_CONFIG_CHANGED"])
        self.assertEqual(_judge(ok, event="push")["reasons"], ["WRONG_EVENT"])
        self.assertEqual(_judge(ok, head="abc")["reasons"], ["BAD_HEAD_SHA"])
        self.assertEqual(_judge(None)["reasons"], ["NO_STATUS_LIST"])

    def test_a_selected_job_whose_paths_are_all_out_of_scope_is_drift(self):
        ok = [_status("success", "2026-11-06T09:00:00Z", 1)]
        r = _judge(ok, paths=["apps/pos/src/main/a.ts", "docs/x.md"])
        self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["SCOPE_DRIFT"]))
        # an empty diff is in scope (the CircleCI job runs; nothing is skipped)
        self.assertEqual(_judge(ok, paths=[])["verdict"], cg.OK)


class ScopeTests(unittest.TestCase):
    OUT = ["apps/pos/src/main/sales/a.ts", "apps/admin-console/src/sales/b.tsx", "apps/pos/package.json",
           "integrations/erpnext-connector/retail_tower_erpnext_connector/hooks.py",
           "tests/e2e/smoke.spec.ts", "docs/x.md", "system/releases/lab.json", "README.md", "ARCHITECTURE.md"]
    IN = ["services/backend-core/apps/api/src/a.ts", "apps/pos/.github/workflows/x.yml",
          "apps/admin-console/.github/scripts/r.mjs", "integrations/erpnext-connector/.github/x.yml",
          ".github/workflows/backend-core.yml", ".circleci/config.yml", "tools/project-graph/graph.yaml",
          "tools/x.py", "CODEOWNERS", ".nvmrc", "package.json", "docsx/a.md", "README.md.bak"]

    def test_scope_predicate(self):
        for p in self.OUT:
            self.assertTrue(cg.out_of_scope([p]), p)
        for p in self.IN:
            self.assertFalse(cg.out_of_scope([p]), p)
            self.assertFalse(cg.out_of_scope(self.OUT + [p]), p)

    def test_the_graph_never_selects_bc_db_integration_for_an_out_of_scope_change(self):
        for p in self.OUT:
            case = {"changes": [{"status": "M", "path": p}]}
            res = ev.evaluate(support.eval_input(case))
            self.assertNotIn("bc/db-integration", res["needed_jobs"], p)

    def test_the_graph_selects_bc_db_integration_for_backend_and_policy_changes(self):
        for p in ["services/backend-core/apps/api/src/a.ts", "apps/pos/.github/workflows/x.yml",
                  "tools/x.py", "package.json"]:
            res = ev.evaluate(support.eval_input({"changes": [{"status": "M", "path": p}]}))
            self.assertIn("bc/db-integration", res["needed_jobs"], p)

    def test_the_circleci_skip_script_uses_the_same_pattern(self):
        js = (REPO_ROOT / ".circleci/scripts/api-gate-scope.cjs").read_text(encoding="utf-8")
        m = re.search(r"const OUT_OF_SCOPE_RE =\s*/(.+)/;", js)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).replace("\\/", "/"), cg.OUT_OF_SCOPE_RE.pattern)


class WiringTests(unittest.TestCase):

    def test_the_cutover_flag_line_matches_the_workflow_check(self):
        src = (support.PG_ROOT / "pgraph/circleci_gate.py").read_text(encoding="utf-8").splitlines()
        self.assertIn("CUTOVER_ENABLED = True", src)
        wf = (REPO_ROOT / ".github/workflows/backend-core.yml").read_text(encoding="utf-8")
        self.assertIn("grep -qx 'CUTOVER_ENABLED = True' \"$gate\"", wf)

    def test_bc_db_integration_verifies_or_runs_never_both(self):
        wf = yaml.safe_load((REPO_ROOT / ".github/workflows/backend-core.yml").read_text(encoding="utf-8"))
        job = wf["jobs"]["bc-db-integration"]
        self.assertEqual(job["name"], "bc/db-integration")
        self.assertEqual(job["permissions"], {"contents": "read", "actions": "read", "checks": "read",
                                              "statuses": "read"})
        steps = job["steps"]
        names = [s.get("name", s.get("uses", "")) for s in steps]
        mode_at = names.index("API Jest provider (RT-1256) - verify CircleCI or run here")
        self.assertEqual(steps[mode_at].get("id"), "mode")
        self.assertNotIn("if", steps[mode_at])
        verify = [s for s in steps if "--statuses" in str(s.get("run", ""))]
        self.assertEqual(len(verify), 1)
        self.assertEqual(verify[0]["if"], "steps.mode.outputs.mode == 'circleci'")
        self.assertIn("--deadline-passed", verify[0]["run"])
        self.assertIn("$RUNNER_TEMP/pgraph-base/tools/project-graph", verify[0]["run"])
        jest = [s for s in steps if "pnpm --filter @data-pulse-2/api test" in str(s.get("run", ""))]
        self.assertEqual(len(jest), 1)
        self.assertTrue(jest[0]["if"].startswith("steps.mode.outputs.mode == 'github'"))
        self.assertIn("--coverage", jest[0]["run"])
        # every step after the verifier belongs to the GitHub-run path
        first_github = names.index("Enable corepack and pin pnpm")
        for s in steps[first_github:]:
            self.assertTrue(str(s.get("if", "")).startswith("steps.mode.outputs.mode == 'github'"), s.get("name"))
        # the decision reads the base archive, never the PR head
        mode_run = steps[mode_at]["run"]
        self.assertIn('git archive "$BASE_SHA" tools/project-graph', mode_run)
        # review fix (RT-1256): a fork PR or a .circleci/ change runs API Jest here instead of
        # failing, so the rollback PR and CI-config PRs can pass; only the last branch verifies.
        self.assertIn('elif [ "$HEAD_REPO" != "$REPO" ]; then\n  why="fork PR"', re.sub(r"\n\s+", "\n  ", mode_run))
        self.assertIn('git diff --quiet "$BASE_SHA" "$HEAD_SHA" -- .circleci/ || rc=$?', mode_run)
        branches = re.findall(r'mode=(\w+)', mode_run)
        self.assertEqual(branches.count("circleci"), 1, branches)
        self.assertLess(mode_run.index('why="fork PR"'), mode_run.index("mode=circleci"))
        self.assertLess(mode_run.index('why=".circleci/ differs'), mode_run.index("mode=circleci"))
        # rename-safe path lists on both sides
        self.assertIn('git diff --name-only --no-renames "$mb" "$HEAD_SHA"', verify[0]["run"])
        cfg = (REPO_ROOT / ".circleci/config.yml").read_text(encoding="utf-8")
        self.assertIn('git diff --name-only --no-renames "$mb" HEAD > /tmp/gate/changed.txt', cfg)

    def test_a_rename_out_of_backend_core_is_in_scope(self):
        # --no-renames lists the old (Backend-Core) path too, so the CircleCI job runs the suite
        self.assertFalse(cg.out_of_scope(["services/backend-core/apps/api/src/a.ts", "docs/a.ts"]))
        res = ev.evaluate(support.eval_input({"changes": [
            {"status": "R100", "path": "docs/a.ts", "old": "services/backend-core/apps/api/src/a.ts"}]}))
        self.assertIn("bc/db-integration", res["needed_jobs"])


ADMIN = "apps/admin-console/src/sales/SalesPage.tsx"


def _admin_status(state, created, sid, **kw):
    kw.setdefault("context", cg.ADMIN_CONTEXT)
    return _status(state, created, sid, **kw)


def _admin_judge(statuses, paths=(ADMIN,), fork=False, cc=False, event="pull_request", late=False, head=H):
    return cg.judge(event, head, fork, cc, list(paths), statuses, late, target="admin")


class AdminVerdictTests(unittest.TestCase):
    """RT-1265: the admin target judges `ci/circleci: admin-vitest-gate` with the same rules."""

    def test_success_from_the_circleci_app_passes(self):
        r = _admin_judge([_admin_status("success", "2026-11-07T09:00:00Z", 1)])
        self.assertEqual(r["verdict"], cg.OK, r)

    def test_absent_pending_failed_and_forged_never_pass(self):
        self.assertEqual(_admin_judge([])["verdict"], cg.PENDING)
        self.assertEqual(_admin_judge([], late=True)["reasons"], ["ABSENT_STATUS"])
        pending = [_admin_status("pending", "2026-11-07T09:00:00Z", 1)]
        self.assertEqual(_admin_judge(pending)["verdict"], cg.PENDING)
        self.assertEqual(_admin_judge(pending, late=True)["reasons"], ["STATUS_INCOMPLETE"])
        for state in ("failure", "error"):
            r = _admin_judge([_admin_status(state, "2026-11-07T09:00:00Z", 1)])
            self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["CIRCLECI_" + state.upper()]))
        forged = [_admin_status("success", "2026-11-07T09:00:00Z", 1, creator_id=1),
                  _admin_status("success", "2026-11-07T09:00:00Z", 2, ctype="User"),
                  _admin_status("success", "2026-11-07T09:00:00Z", 3, url="https://evil.example/x")]
        r = _admin_judge(forged, late=True)
        self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["ABSENT_STATUS"]))
        self.assertEqual(len(r["rejected"]), 3)

    def test_the_newest_status_decides(self):
        old_ok = _admin_status("success", "2026-11-07T09:00:00Z", 1)
        new_fail = _admin_status("failure", "2026-11-07T09:05:00Z", 2)
        self.assertEqual(_admin_judge([old_ok, new_fail])["verdict"], cg.FAIL)
        new_ok = _admin_status("success", "2026-11-07T09:10:00Z", 3)
        self.assertEqual(_admin_judge([old_ok, new_fail, new_ok])["verdict"], cg.OK)

    def test_the_two_targets_never_accept_each_others_status(self):
        api_ok = [_status("success", "2026-11-07T09:00:00Z", 1)]
        admin_ok = [_admin_status("success", "2026-11-07T09:00:00Z", 2)]
        self.assertEqual(_admin_judge(api_ok, late=True)["reasons"], ["ABSENT_STATUS"])
        self.assertEqual(_judge(admin_ok, late=True)["reasons"], ["ABSENT_STATUS"])
        other = [_admin_status("success", "2026-11-07T09:00:00Z", 3, context="ci/circleci: remote-admin")]
        self.assertEqual(_admin_judge(other, late=True)["reasons"], ["ABSENT_STATUS"])

    def test_fork_config_change_wrong_event_and_drift_fail_before_any_status(self):
        ok = [_admin_status("success", "2026-11-07T09:00:00Z", 1)]
        self.assertEqual(_admin_judge(ok, fork=True)["reasons"], ["FORK_PR"])
        self.assertEqual(_admin_judge(ok, cc=True)["reasons"], ["CIRCLECI_CONFIG_CHANGED"])
        self.assertEqual(_admin_judge(ok, event="push")["reasons"], ["WRONG_EVENT"])
        self.assertEqual(_admin_judge(ok, head="abc")["reasons"], ["BAD_HEAD_SHA"])
        r = _admin_judge(ok, paths=["apps/pos/src/main/a.ts", "docs/x.md"])
        self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["SCOPE_DRIFT"]))

    def test_a_path_list_that_is_not_a_list_fails_for_both_targets(self):
        for target in ("api", "admin"):
            r = cg.judge("pull_request", H, False, False, None, [], False, target=target)
            self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["NO_PATHS"]), target)

    def test_an_unknown_target_fails(self):
        ok = [_admin_status("success", "2026-11-07T09:00:00Z", 1)]
        r = cg.judge("pull_request", H, False, False, [ADMIN], ok, False, target="pos")
        self.assertEqual((r["verdict"], r["reasons"]), (cg.FAIL, ["UNKNOWN_TARGET"]))

    def test_the_api_target_is_unchanged_by_default(self):
        ok = [_status("success", "2026-11-07T09:00:00Z", 1)]
        self.assertEqual(cg.judge("pull_request", H, False, False, [API], ok),
                         cg.judge("pull_request", H, False, False, [API], ok, False, target="api"))
        self.assertEqual(cg.CONTEXT, "ci/circleci: api-jest-gate")
        # an Admin-only change is still out of scope for the API gate, and in scope for Admin
        self.assertTrue(cg.out_of_scope([ADMIN]))
        self.assertFalse(cg.out_of_scope([ADMIN], "admin"))


class AdminScopeTests(unittest.TestCase):
    OUT = ["apps/pos/src/main/sales/a.ts", "apps/pos/package.json",
           "integrations/erpnext-connector/retail_tower_erpnext_connector/hooks.py",
           "services/backend-core/apps/api/src/reports/report.service.ts",
           "services/backend-core/packages/db/src/schema/sales/sales.ts",
           "services/backend-core/apps/api/test/auth/a.spec.ts",
           "apps/admin-console/docs/x.md", "apps/admin-console/specs/009/spec.md",
           "apps/admin-console/README.md", "apps/admin-console/design/a.html",
           "tests/e2e/smoke.spec.ts", "docs/x.md", "system/releases/lab.json", "README.md", "ARCHITECTURE.md"]
    IN = ["apps/admin-console/src/sales/b.tsx", "apps/admin-console/tests/unit/a.test.ts",
          "apps/admin-console/package.json", "apps/admin-console/vitest.config.ts",
          "apps/admin-console/docs.md/x.ts", "apps/admin-console/src/README.md",
          "apps/admin-console/.github/scripts/r.mjs", "apps/pos/.github/workflows/x.yml",
          "services/backend-core/packages/contracts/openapi/openapi.yaml",
          "services/backend-core/apps/api/src/openapi/x.ts",
          "services/backend-core/apps/api/test/contract-conformance.spec.ts",
          "services/backend-core/apps/api/test/openapi/x.spec.ts",
          "services/backend-core/tools/oasdiff/x.mjs", "services/backend-core/tools/schemathesis/x.py",
          "services/backend-core/packages/shared/__tests__/observability/obs1-golden-vectors.json",
          "services/backend-core/.github/workflows/x.yml",
          ".github/workflows/admin-console.yml", ".circleci/config.yml", "tools/project-graph/graph.yaml",
          "tools/x.py", "CODEOWNERS", ".nvmrc", "package.json", "docsx/a.md", "README.md.bak"]

    def test_scope_predicate(self):
        for p in self.OUT:
            self.assertTrue(cg.out_of_scope([p], "admin"), p)
        for p in self.IN:
            self.assertFalse(cg.out_of_scope([p], "admin"), p)
            self.assertFalse(cg.out_of_scope(self.OUT + [p], "admin"), p)
        self.assertFalse(cg.out_of_scope([], "admin"))

    def test_the_graph_never_selects_admin_build_test_for_an_out_of_scope_change(self):
        for p in self.OUT:
            res = ev.evaluate(support.eval_input({"changes": [{"status": "M", "path": p}]}))
            self.assertNotIn("admin/build-test", res["needed_jobs"], p)

    def test_the_graph_selects_admin_build_test_for_every_in_scope_example(self):
        for p in self.IN:
            # docsx/a.md: an unknown root path fails the plan (never green). .circleci/: selects only
            # contracts/check (RT-1173); in scope here is only "the CircleCI job does not skip", and
            # it refuses anyway because .circleci/ differs from main.
            if p in ("docsx/a.md", ".circleci/config.yml"):
                continue
            res = ev.evaluate(support.eval_input({"changes": [{"status": "M", "path": p}]}))
            self.assertIn("admin/build-test", res["needed_jobs"], p)

    def test_no_tracked_path_the_halt_pattern_skips_selects_admin_build_test(self):
        # Selection is a union over paths, so one evaluation over every tracked path the pattern
        # skips proves that none of them selects admin/build-test on its own.
        out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO_ROOT, check=True,
                             capture_output=True).stdout.decode("utf-8").split("\0")
        skipped = [p for p in out if p and cg.ADMIN_OUT_OF_SCOPE_RE.match(p)]
        self.assertGreater(len(skipped), 1000)
        res = ev.evaluate(support.eval_input({"changes": [{"status": "M", "path": p} for p in skipped]}))
        self.assertNotIn("admin/build-test", res["needed_jobs"])

    def test_the_circleci_skip_script_uses_the_same_pattern(self):
        js = (REPO_ROOT / ".circleci/scripts/admin-gate-scope.cjs").read_text(encoding="utf-8")
        m = re.search(r"const OUT_OF_SCOPE_RE =\s*/(.+)/;", js)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).replace("\\/", "/"), cg.ADMIN_OUT_OF_SCOPE_RE.pattern)


class AdminWiringTests(unittest.TestCase):

    def test_the_admin_cutover_flag_line_matches_the_workflow_check(self):
        src = (support.PG_ROOT / "pgraph/circleci_gate.py").read_text(encoding="utf-8").splitlines()
        self.assertIn("ADMIN_CUTOVER_ENABLED = True", src)
        wf = (REPO_ROOT / ".github/workflows/admin-console.yml").read_text(encoding="utf-8")
        self.assertIn("grep -qx 'ADMIN_CUTOVER_ENABLED = True' \"$gate\"", wf)

    def test_admin_build_test_verifies_or_runs_vitest_never_both(self):
        wf = yaml.safe_load((REPO_ROOT / ".github/workflows/admin-console.yml").read_text(encoding="utf-8"))
        job = wf["jobs"]["admin-build-test"]
        self.assertEqual(job["name"], "admin/build-test")
        self.assertEqual(job["permissions"], {"contents": "read", "statuses": "read"})
        self.assertEqual(job["timeout-minutes"], 30)
        steps = job["steps"]
        names = [s.get("name", s.get("uses", "")) for s in steps]
        mode_at = names.index("Vitest provider (RT-1265) - verify CircleCI or run here")
        self.assertEqual(steps[mode_at].get("id"), "mode")
        self.assertNotIn("if", steps[mode_at])
        mode_run = steps[mode_at]["run"]
        self.assertIn('git archive "$BASE_SHA" tools/project-graph', mode_run)
        self.assertEqual(re.findall(r"mode=(\w+)", mode_run).count("circleci"), 1)
        self.assertLess(mode_run.index('why="fork PR"'), mode_run.index("mode=circleci"))
        self.assertLess(mode_run.index('why=".circleci/ differs'), mode_run.index("mode=circleci"))
        verify = [s for s in steps if "--statuses" in str(s.get("run", ""))]
        self.assertEqual(len(verify), 1)
        self.assertEqual(verify[0]["if"], "steps.mode.outputs.mode == 'circleci'")
        self.assertIn("circleci-gate --target admin", verify[0]["run"])
        self.assertIn("--deadline-passed", verify[0]["run"])
        self.assertIn("deadline=$((SECONDS + 20 * 60))", verify[0]["run"])
        # the step outlives the 20-minute deadline, and the job outlives the step
        self.assertEqual(verify[0]["timeout-minutes"], 22)
        self.assertLess(verify[0]["timeout-minutes"], job["timeout-minutes"])
        self.assertIn("$RUNNER_TEMP/pgraph-base/tools/project-graph", verify[0]["run"])
        self.assertIn('git diff --name-only --no-renames "$mb" "$HEAD_SHA"', verify[0]["run"])
        vitest = [s for s in steps if str(s.get("run", "")).strip() == "pnpm test"]
        self.assertEqual(len(vitest), 1)
        self.assertEqual(vitest[0]["if"], "steps.mode.outputs.mode == 'github'")
        # every other check of the job still runs in both modes
        for n in ("Regenerate API client", "Check API client is up to date", "Build",
                  "Parity manifest (unstamped dist, RT-711)", "Lint", "Code-health ratchet (RT-1200)"):
            self.assertNotIn("if", steps[names.index(n)], n)
        sonar = steps[names.index("Upload lcov for the Sonar scan (main pushes only)")]
        self.assertEqual(sonar["if"], "github.event_name == 'push' && !cancelled()")
        cfg = (REPO_ROOT / ".circleci/config.yml").read_text(encoding="utf-8")
        self.assertIn('git diff --name-only --no-renames "$mb" HEAD > /tmp/gate/changed.txt', cfg)


class CliTests(unittest.TestCase):

    def _run(self, statuses, paths, *extra):
        with tempfile.TemporaryDirectory() as d:
            sp, pp = pathlib.Path(d, "s.json"), pathlib.Path(d, "p.txt")
            sp.write_text(json.dumps(statuses), encoding="utf-8")
            if paths is not None:
                pp.write_text("\n".join(paths) + "\n", encoding="utf-8")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cli_main(["circleci-gate", "--event", "pull_request", "--head", H,
                               "--statuses", str(sp), "--paths", str(pp), *extra])
            return rc, json.loads(buf.getvalue())

    def test_exit_codes(self):
        ok = [_status("success", "2026-11-06T09:00:00Z", 1)]
        self.assertEqual(self._run(ok, [API])[0], 0)
        self.assertEqual(self._run([], [API])[0], 3)
        self.assertEqual(self._run([], [API], "--deadline-passed")[0], 1)
        self.assertEqual(self._run(ok, [API], "--fork")[0], 1)
        self.assertEqual(self._run(ok, [API], "--circleci-changed")[0], 1)
        rc, out = self._run(ok, None)
        self.assertEqual((rc, out["reasons"]), (1, ["NO_PATHS"]))

    def test_admin_target_exit_codes(self):
        ok = [_admin_status("success", "2026-11-07T09:00:00Z", 1)]
        self.assertEqual(self._run(ok, [ADMIN], "--target", "admin")[0], 0)
        self.assertEqual(self._run(ok, [ADMIN])[0], 1)   # the default target is api: SCOPE_DRIFT
        self.assertEqual(self._run([], [ADMIN], "--target", "admin")[0], 3)
        self.assertEqual(self._run([], [ADMIN], "--target", "admin", "--deadline-passed")[0], 1)
        self.assertEqual(self._run(ok, [ADMIN], "--target", "admin", "--fork")[0], 1)
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                self._run(ok, [ADMIN], "--target", "pos")


if __name__ == "__main__":
    unittest.main()
