"""Phase-3 advisory Port attribution: exact service ownership, fail closed."""

import unittest
from unittest.mock import patch

from pgraph import port_attribution as pa
from pgraph.evaluate import Change
from pgraph.graph import Graph, load_graph

import support


BASE = support.BASE
HEAD = support.HEAD


class PortAttributionTests(unittest.TestCase):
    def setUp(self):
        self.graph = Graph(load_graph(support.trusted_text()))

    def classify(self, *rows):
        return pa.classify_changes(self.graph, tuple(Change(**row) for row in rows),
                                   BASE, HEAD, BASE, 123)

    def test_single_product_without_any_new_mapping_rules(self):
        result = self.classify({"status": "M", "path": "apps/pos/src/main/payments.ts"})
        self.assertEqual(result["attribution_status"], "classified")
        self.assertEqual(result["attribution_scope"], "single")
        self.assertEqual(result["affected_services"], ["pos"])
        self.assertEqual(result["reason_codes"], [])

    def test_two_products_are_both_directly_affected(self):
        result = self.classify({"status": "M", "path": "apps/pos/src/a.ts"},
                               {"status": "A", "path": "services/backend-core/src/a.ts"})
        self.assertEqual(result["attribution_scope"], "multi")
        self.assertEqual(result["affected_services"], ["backend-core", "pos"])

    def test_renamed_across_two_products_tracks_old_and_new(self):
        result = self.classify({"status": "R", "path": "apps/admin-console/src/a.ts",
                                "old_path": "apps/pos/src/a.ts"})
        self.assertEqual(result["affected_services"], ["admin-console", "pos"])
        self.assertEqual(result["changed_paths"], 2)

    def test_rename_missing_origin_fails_closed(self):
        result = self.classify({"status": "R", "path": "apps/pos/src/a.ts"})
        self.assertEqual(result["attribution_status"], "insufficient_evidence")
        self.assertEqual(result["affected_services"], [])
        self.assertIn("INVALID_OR_MISSING_PATH", result["reason_codes"])

    def test_copy_changes_only_destination(self):
        result = self.classify({"status": "C", "path": "apps/pos/src/copied.ts",
                                "old_path": "services/backend-core/src/original.ts"})
        self.assertEqual(result["affected_services"], ["pos"])

    def test_policy_change_inside_product_does_not_impersonate_service_change(self):
        result = self.classify({"status": "M", "path": "apps/pos/.github/workflows/ci.yml"})
        self.assertEqual(result["attribution_scope"], "shared")
        self.assertEqual(result["affected_services"], [])
        self.assertIn("policy", result["shared_classes"])

    def test_root_policy_select_all_does_not_mean_all_directly_affected(self):
        result = self.classify({"status": "M", "path": ".github/workflows/pos.yml"})
        self.assertEqual(result["attribution_scope"], "shared")
        self.assertEqual(result["affected_services"], [])

    def test_mixed_service_and_shared_docs_does_not_add_fake_services(self):
        result = self.classify({"status": "M", "path": "apps/pos/src/main/a.ts"},
                               {"status": "M", "path": "docs/architecture.md"})
        self.assertEqual(result["attribution_scope"], "single")
        self.assertEqual(result["affected_services"], ["pos"])
        self.assertIn("docs", result["shared_classes"])

    def test_unknown_path_makes_entire_attribution_unknown(self):
        result = self.classify({"status": "M", "path": "apps/pos/src/main/a.ts"},
                               {"status": "M", "path": "unknown-nested/new-feature/file.py"})
        self.assertEqual(result["attribution_status"], "insufficient_evidence")
        self.assertEqual(result["attribution_scope"], "unknown")
        self.assertEqual(result["affected_services"], [])
        self.assertIn("UNKNOWN_PATH", result["reason_codes"])

    def test_untrusted_path_traversal_fails_closed(self):
        for path in ("../apps/pos/x.ts", "/apps/pos/x.ts", "apps//pos/a.ts", "apps/pos/../a.ts",
                     "apps\\pos\\a.ts", "apps/pos/\x00x"):
            with self.subTest(path=path):
                result = self.classify({"status": "M", "path": path})
                self.assertEqual(result["attribution_status"], "insufficient_evidence")
                self.assertEqual(result["affected_services"], [])

    def test_non_regular_file_and_unknown_diff_status_fail_closed(self):
        for change in ({"status": "A", "path": "apps/pos/link", "mode": "120000"},
                       {"status": "T", "path": "apps/pos/x"}):
            with self.subTest(change=change):
                result = self.classify(change)
                self.assertEqual(result["affected_services"], [])
                self.assertEqual(result["attribution_status"], "insufficient_evidence")

    def test_empty_or_too_large_diff_refuses_to_guess(self):
        self.assertIn("INCOMPLETE_OR_OVERSIZE_DIFF", self.classify()["reason_codes"])
        data = [Change("A", "apps/pos/a.ts") for _ in range(pa.MAX_CHANGES + 1)]
        out = pa.classify_changes(self.graph, data, BASE, HEAD, BASE, 123)
        self.assertEqual(out["affected_services"], [])

    def test_invalid_commit_sha_refuses_to_claim_provenance(self):
        out = pa.classify_changes(self.graph, [Change("M", "apps/pos/x.ts")], "main", HEAD, BASE, 123)
        self.assertIn("INVALID_COMMIT_SHA", out["reason_codes"])

    def test_repeat_is_deterministic_and_fingerprint_tracks_input(self):
        first = self.classify({"status": "M", "path": "integrations/erpnext-connector/api/a.py"})
        second = self.classify({"status": "M", "path": "integrations/erpnext-connector/api/a.py"})
        changed = self.classify({"status": "M", "path": "integrations/erpnext-connector/api/b.py"})
        self.assertEqual(first, second)
        self.assertEqual(first["affected_services"], ["erpnext-connector"])
        self.assertNotEqual(first["input_fingerprint"], changed["input_fingerprint"])

    def test_git_object_path_uses_trusted_base_and_merge_base_diff(self):
        changes = [Change("M", "apps/pos/src/a.ts")]
        with patch.object(pa.gitio, "read_text", return_value=support.trusted_text()) as read, \
             patch.object(pa.gitio, "merge_base", return_value=BASE) as merge, \
             patch.object(pa.gitio, "read_changes", return_value=changes) as diff:
            out = pa.classify_git("/repo", BASE, HEAD, 123)
        read.assert_called_once_with("/repo", BASE, pa.GRAPH_PATH)
        merge.assert_called_once_with("/repo", BASE, HEAD)
        diff.assert_called_once_with("/repo", BASE, HEAD)
        self.assertEqual(out["attribution_status"], "classified")
        self.assertEqual(out["affected_services"], ["pos"])

    def test_unavailable_git_evidence_never_returns_success(self):
        with patch.object(pa.gitio, "read_text", return_value=None):
            out = pa.classify_git("/repo", BASE, HEAD, 123)
        self.assertEqual(out["affected_services"], [])
        self.assertIn("TRUSTED_GRAPH_UNAVAILABLE", out["reason_codes"])

    def test_missing_merge_base_never_returns_success(self):
        with patch.object(pa.gitio, "read_text", return_value=support.trusted_text()), \
             patch.object(pa.gitio, "merge_base", side_effect=pa.gitio.DiffUnavailable("no base")):
            out = pa.classify_git("/repo", BASE, HEAD, 123)
        self.assertEqual(out["affected_services"], [])
        self.assertIn("GIT_OR_GRAPH_EVIDENCE_UNAVAILABLE", out["reason_codes"])

    def test_unverified_trusted_graph_is_rejected(self):
        with patch.object(pa.gitio, "read_text", return_value="schema: wrong"):
            out = pa.classify_git("/repo", BASE, HEAD, 123)
        self.assertEqual(out["affected_services"], [])
        self.assertIn("TRUSTED_GRAPH_INVALID", out["reason_codes"])


if __name__ == "__main__":
    unittest.main()
