import unittest

from pgraph import boundary as bd
from pgraph.graph import Graph, GraphError, guard_keys, load_graph, validate_graph

import support


def _real():
    return load_graph(support.trusted_text())


def _codes(errors):
    return {e.split(":", 1)[0] for e in errors}


class LoadTests(unittest.TestCase):

    def test_real_graph_loads(self):
        self.assertEqual(_real()["schema"], "retail-tower/project-graph@1")

    def test_rejects_aliases_anchors_duplicates_and_oversize(self):
        bad = {
            "alias": "a: &x 1\nb: *x\n",
            "duplicate": "a: 1\na: 2\n",
            "not-a-mapping": "- 1\n- 2\n",
            "syntax": "a: [\n",
            "oversize": "a: '" + "x" * 300_000 + "'\n",
            "python-tag": "a: !!python/object:os.system x\n",
        }
        for name, text in bad.items():
            with self.subTest(name=name):
                with self.assertRaises(GraphError):
                    load_graph(text)


class StaticRuleTests(unittest.TestCase):

    def test_real_graph_valid_when_all_jobs_exist(self):
        g = _real()
        self.assertEqual(validate_graph(g, workflow_jobs=dict(g["jobs"])), [])

    def test_rule1_overlapping_product_roots(self):
        g = _real()
        g["products"]["admin-console"]["root"] = "apps/pos/admin/"
        self.assertIn("ROOT_OVERLAP", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule2_shared_glob_inside_product_root(self):
        g = _real()
        g["shared_classes"]["tooling"]["globs"].append("apps/pos/tools/**")
        self.assertIn("SHARED_GLOB_IN_PRODUCT", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule2_unanchored_shared_glob(self):
        g = _real()
        g["shared_classes"]["docs"]["globs"].append("**/README.md")
        self.assertIn("SHARED_GLOB_IN_PRODUCT", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule3_tier_glob_escaping_product(self):
        g = _real()
        g["products"]["pos"]["tiers"]["money"]["globs"].append("../backend-core/x")
        self.assertIn("TIER_GLOB_OUTSIDE_PRODUCT", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule4_missing_lockfile_and_via_at_head(self):
        g = _real()
        tree = {"apps/pos/package-lock.json"}
        codes = _codes(validate_graph(g, tree_paths=tree, workflow_jobs=dict(g["jobs"])))
        self.assertIn("LOCKFILE_MISSING", codes)
        self.assertIn("EDGE_VIA_MISSING", codes)
        self.assertIn("GENERATED_PATH_MISSING", codes)

    def test_rule5_job_missing_from_workflow(self):
        g = _real()
        jobs = dict(g["jobs"])
        del jobs["pos/static"]
        errors = validate_graph(g, workflow_jobs=jobs)
        self.assertIn("CI_JOB_MISSING: pos/static", errors)

    def test_rule5_unknown_job_reference(self):
        g = _real()
        g["products"]["pos"]["tiers"]["money"]["jobs"].append("pos/nope")
        self.assertIn("UNKNOWN_JOB", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule5_job_owned_by_two_products(self):
        g = _real()
        g["products"]["admin-console"]["ci_jobs"].append("pos/static")
        self.assertIn("DUPLICATE_JOB", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule5b_guarded_workflows_are_valid(self):
        g = _real()
        self.assertEqual(validate_graph(g, workflow_jobs=dict(g["jobs"]),
                                        workflows=support.guarded_workflows(g)), [])

    def test_rule5b_unguarded_job(self):
        g = _real()
        wfs = support.guarded_workflows(g)
        del wfs[".github/workflows/pos.yml"]["pos/docs"]["if"]
        self.assertIn("CI_JOB_UNGUARDED: pos/docs", validate_graph(g, workflows=wfs))

    def test_rule5b_guard_without_needs_plan(self):
        g = _real()
        wfs = support.guarded_workflows(g)
        wfs[".github/workflows/backend-core.yml"]["bc/oasdiff"]["needs"] = []
        self.assertIn("CI_JOB_UNGUARDED: bc/oasdiff", validate_graph(g, workflows=wfs))

    def test_rule5b_dependency_chain(self):
        g = _real()
        wfs = support.guarded_workflows(g)
        bc = wfs[".github/workflows/backend-core.yml"]
        bc["shard"] = {"name": "schemathesis shard ${{ matrix.shard }}", "needs": "plan",
                       "if": "contains(fromJSON(needs.plan.outputs.jobs), 'bc/fast')"}
        bc["bc/schemathesis"]["needs"] = ["plan", "shard"]
        self.assertIn("CI_JOB_UNGUARDED: bc/schemathesis (via shard)", validate_graph(g, workflows=wfs))
        bc["shard"]["if"] = "contains(fromJSON(needs.plan.outputs.jobs), 'bc/schemathesis')"
        self.assertEqual(validate_graph(g, workflows=wfs), [])
        bc["bc/schemathesis"]["needs"] = ["plan", "missing"]
        self.assertIn("CI_JOB_UNGUARDED: bc/schemathesis (via missing) is not defined",
                      validate_graph(g, workflows=wfs))

    def test_rule5b_plan_job_must_exist_and_be_unconditional(self):
        g = _real()
        wfs = support.guarded_workflows(g)
        wfs[".github/workflows/e2e.yml"]["plan"]["if"] = "false"
        self.assertIn("CI_PLAN_MISSING: .github/workflows/e2e.yml", validate_graph(g, workflows=wfs))
        del wfs[".github/workflows/e2e.yml"]["plan"]
        self.assertIn("CI_PLAN_MISSING: .github/workflows/e2e.yml", validate_graph(g, workflows=wfs))

    def test_rule5b_duplicate_key_definitions(self):
        g = _real()
        for where in (".github/workflows/pos.yml", ".github/workflows/project-graph.yml"):
            with self.subTest(where=where):
                wfs = support.guarded_workflows(g)
                wfs[where]["copy"] = {"name": "pos/static"}
                self.assertIn("CI_JOB_UNGUARDED: pos/static is defined by 2 jobs", validate_graph(g, workflows=wfs))

    def test_rule5b_always_jobs_stay_unguarded(self):
        g = _real()
        wfs = support.guarded_workflows(g)
        wfs[".github/workflows/project-graph.yml"]["dependency-review"]["needs"] = "plan"
        self.assertIn("ALWAYS_JOB_GUARDED: dependency-review", validate_graph(g, workflows=wfs))

    def test_guard_keys_accepts_only_the_canonical_shape(self):
        c = "contains(fromJSON(needs.plan.outputs.jobs), '{}')"
        self.assertEqual(guard_keys(c.format("pos/test")), {"pos/test"})
        self.assertEqual(guard_keys("${{ " + c.format("a") + " || " + c.format("b") + " }}"), {"a", "b"})
        self.assertEqual(guard_keys("${{ !cancelled() && needs.plan.result == 'success' && (" + c.format("a") + ") }}"),
                         {"a"})
        for bad in (None, "", "true", "always() || " + c.format("a"), c.format("a") + " || true",
                    "!cancelled() && " + c.format("a"), "contains(needs.plan.outputs.jobs, 'a')",
                    "contains(fromJSON(needs.other.outputs.jobs), 'a')",
                    # `&&` binds tighter than `||`: b would run without the prefix's checks
                    "!cancelled() && needs.plan.result == 'success' && " + c.format("a") + " || " + c.format("b")):
            with self.subTest(expr=bad):
                self.assertIsNone(guard_keys(bad))

    def test_policy_class_may_reach_into_product_roots(self):
        g = _real()
        self.assertEqual(validate_graph(g, workflow_jobs=dict(g["jobs"])), [])
        g["shared_classes"]["tooling"]["globs"].append("apps/*/.github/**")
        self.assertIn("SHARED_GLOB_IN_PRODUCT", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_rule6_same_precedence_overlap(self):
        g = _real()
        g["shared_classes"]["docs"]["globs"].append("tests/e2e/docs/**")
        self.assertIn("SAME_PRECEDENCE_OVERLAP", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))

    def test_schema_errors(self):
        g = _real()
        g["schema"] = "other@2"
        self.assertIn("SCHEMA", _codes(validate_graph(g, workflow_jobs=dict(g["jobs"]))))
        g = _real()
        del g["products"]
        self.assertIn("SCHEMA", _codes(validate_graph(g)))

    def test_proposed_graph_with_extra_approver_still_validates(self):
        g = _real()
        g["policy_approvers"] = ["someone"]
        self.assertEqual(validate_graph(g, workflow_jobs=dict(g["jobs"])), [])


class ClassifyTests(unittest.TestCase):

    def setUp(self):
        self.g = Graph(_real())

    def test_shared_precedence(self):
        self.assertEqual(self.g.classify("CODEOWNERS").owner, "policy")
        self.assertEqual(self.g.classify("tools/project-graph/x").owner, "policy")
        self.assertEqual(self.g.classify("tools/agent-broker/broker.py").owner, "policy")
        self.assertEqual(self.g.classify("tools/history/frozen.tsv").owner, "tooling")
        self.assertEqual(self.g.classify("LICENSE").owner, "root")
        self.assertEqual(self.g.classify("docs/a.md").owner, "docs")

    def test_root_prose_files_are_rootdocs_not_root(self):
        # RT-578: precedence 3 (rootdocs) beats 4 (root "*"); only the two named files, anchored at the root.
        self.assertEqual(self.g.classify("README.md").owner, "rootdocs")
        self.assertEqual(self.g.classify("ARCHITECTURE.md").owner, "rootdocs")
        self.assertEqual(self.g.classify("NEWS.md").owner, "root")
        self.assertEqual(self.g.classify("apps/pos/README.md").kind, "product")

    def test_system_releases_select_the_contracts_check(self):
        # RT-1030: a system release manifest has its own class (it selects all, which runs contracts/check).
        self.assertEqual(self.g.classify("system/releases/lab-2026.11.0.json").owner, "system")
        self.assertEqual(self.g.classify("system/releases/README.md").owner, "system")

    def test_product_github_dirs_are_policy(self):
        g = self.g
        for path in ("apps/pos/.github/workflows/ci.yml", "apps/admin-console/.github/scripts/fetch-pinned-contracts.sh",
                     "services/backend-core/.github/scripts/ci-tier.sh",
                     "integrations/erpnext-connector/.github/workflows/ci.yml"):
            with self.subTest(path=path):
                self.assertEqual(g.classify(path)[:2], ("class", "policy"))
        # only the product root's own .github/, not a nested one
        self.assertEqual(g.classify("apps/pos/src/.github/x").kind, "product")

    def test_boundary_still_scans_product_github_dirs(self):
        g = self.g
        self.assertEqual(g.classify("apps/admin-console/.github/scripts/x.mjs").owner, "policy")
        self.assertEqual(g.product_of("apps/admin-console/.github/scripts/x.mjs"), "admin-console")
        result = bd.scan(g, {"apps/admin-console/.github/scripts/x.mjs": "import x from '../../../pos/src/a.js'\n"}, [])
        self.assertEqual([v["to_product"] for v in result["violations"]], ["pos"])

    def test_product_tiers(self):
        c = self.g.classify("apps/pos/src/main/payments/a.ts")
        self.assertEqual((c.kind, c.owner, set(c.tiers)), ("product", "pos", {"money"}))
        c = self.g.classify("apps/pos/electron-builder.yml")
        self.assertEqual(set(c.tiers), {"electron-security", "windows-packaging"})

    def test_low_dropped_when_another_tier_matches(self):
        data = _real()
        data["products"]["pos"]["tiers"]["low"]["globs"].append("src/main/payments/**")
        c = Graph(data).classify("apps/pos/src/main/payments/a.ts")
        self.assertEqual(set(c.tiers), {"money"})

    def test_bc_docs_are_high_until_quoted_literal_rule_exists(self):
        self.assertEqual(self.g.classify("services/backend-core/deploy/README.md").tiers, ("deploy-security",))
        self.assertEqual(self.g.classify("services/backend-core/docs/guide.md").tiers, ("high",))

    def test_exclude_removes_a_tier_match(self):
        data = _real()
        data["products"]["pos"]["tiers"]["low"]["exclude"] = ["docs/**/*.sql"]
        g = Graph(data)
        self.assertEqual(g.classify("apps/pos/docs/a.md").tiers, ("low",))
        self.assertEqual(g.classify("apps/pos/docs/a.sql").tiers, ("high",))

    def test_unknown(self):
        self.assertEqual(self.g.classify("foo/x").kind, "unknown")

    def test_ambiguous_same_precedence(self):
        data = _real()
        data["shared_classes"]["e2e"]["globs"].append("docs/**")
        self.assertEqual(Graph(data).classify("docs/a.md").kind, "ambiguous")


if __name__ == "__main__":
    unittest.main()
