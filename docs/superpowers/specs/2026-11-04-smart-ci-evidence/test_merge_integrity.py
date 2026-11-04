"""Offline tests for merge_integrity.classify_merge (RT-866 / smart CI Phase 0).

Fixtures copy the verified cases from the design, section 3.0. Run:
    python -m unittest docs/superpowers/specs/2026-11-04-smart-ci-evidence/test_merge_integrity.py -v
"""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from merge_integrity import classify_merge  # noqa: E402


def run(status, conclusion, started, completed=None):
    return {"status": status, "conclusion": conclusion, "started_at": started, "completed_at": completed}


class ClassifyMergeTest(unittest.TestCase):
    def test_merged_while_in_progress(self):
        # PR #273: merged while both `required` check-runs were still waiting.
        runs = [run("in_progress", None, "2026-11-03T14:33:25Z"), run("in_progress", None, "2026-11-03T14:38:26Z")]
        self.assertEqual(classify_merge("2026-11-03T14:43:45Z", runs), "MERGED_BEFORE_GREEN")

    def test_no_required_at_all(self):
        # PR #292: merged 2 s after the push; no `required` was ever posted.
        self.assertEqual(classify_merge("2026-11-04T08:24:14Z", []), "NO_REQUIRED")

    def test_green_before_merge(self):
        runs = [run("completed", "success", "2026-11-03T10:49:00Z", "2026-11-03T10:50:00Z")]
        self.assertEqual(classify_merge("2026-11-03T10:56:12Z", runs), "GREEN_BEFORE_MERGE")

    def test_green_after_merge_does_not_count(self):
        runs = [run("completed", "success", "2026-11-03T14:45:00Z", "2026-11-03T14:46:00Z")]
        self.assertEqual(classify_merge("2026-11-03T14:43:09Z", runs), "MERGED_BEFORE_GREEN")

    def test_latest_completed_before_merge_wins(self):
        runs = [
            run("completed", "success", "2026-11-03T09:59:00Z", "2026-11-03T10:00:00Z"),
            run("completed", "failure", "2026-11-03T10:04:00Z", "2026-11-03T10:05:00Z"),
        ]
        self.assertEqual(classify_merge("2026-11-03T10:10:00Z", runs), "RED_AT_MERGE")

    def test_newer_waiting_run_after_success_blocks(self):
        # A later `required: waiting` was posted before the merge: the newest verdict was not green.
        runs = [
            run("completed", "success", "2026-11-03T10:00:00Z", "2026-11-03T10:01:00Z"),
            run("in_progress", None, "2026-11-03T10:05:00Z"),
        ]
        self.assertEqual(classify_merge("2026-11-03T10:10:00Z", runs), "MERGED_BEFORE_GREEN")

    def test_completed_at_merge_instant_is_not_green(self):
        runs = [run("completed", "success", "2026-11-03T10:00:00Z", "2026-11-03T10:10:00Z")]
        self.assertEqual(classify_merge("2026-11-03T10:10:00Z", runs), "MERGED_BEFORE_GREEN")

    def test_run_started_after_merge_is_ignored(self):
        runs = [
            run("completed", "success", "2026-11-03T10:00:00Z", "2026-11-03T10:01:00Z"),
            run("in_progress", None, "2026-11-03T10:20:00Z"),
        ]
        self.assertEqual(classify_merge("2026-11-03T10:10:00Z", runs), "GREEN_BEFORE_MERGE")


if __name__ == "__main__":
    unittest.main()
