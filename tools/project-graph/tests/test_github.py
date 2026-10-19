"""Normalisation of GitHub REST payloads into aggregator records. Payloads
mirror the documented REST shapes (workflow runs, jobs with filter=all,
check-runs, pull request reviews)."""

import unittest

from pgraph import github

REPO = "Kemetra/Retail-Tower-Shadow"
HEAD = "2" * 40
BASE = "1" * 40
FP = "a" * 64


def _wf_run(run_id, path=".github/workflows/pos.yml", repo=REPO, status="completed", event="pull_request"):
    return {"id": run_id, "path": path, "event": event, "head_sha": HEAD, "status": status,
            "run_attempt": 2, "repository": {"full_name": repo}}


def _job(name, attempt, check_id, conclusion="success", status="completed"):
    return {"name": name, "run_attempt": attempt, "head_sha": HEAD, "status": status,
            "conclusion": conclusion,
            "check_run_url": f"https://api.github.com/repos/{REPO}/check-runs/{check_id}"}


class NormalizeRunsTests(unittest.TestCase):

    def test_each_attempt_keeps_its_own_attempt_number(self):
        records = github.normalize_runs(
            REPO, [_wf_run(10)],
            {10: [_job("pos/static", 1, 501, "success"), _job("pos/static", 2, 502, "failure")]},
            [{"id": 501, "app": {"id": 15368}}, {"id": 502, "app": {"id": 15368}}],
        )
        self.assertEqual(sorted((r["run_attempt"], r["conclusion"]) for r in records),
                         [(1, "success"), (2, "failure")])
        self.assertTrue(all(r["workflow_path"] == ".github/workflows/pos.yml" for r in records))
        self.assertTrue(all(r["run_id"] == 10 and r["event"] == "pull_request" for r in records))

    def test_producer_comes_from_the_joined_check_run(self):
        records = github.normalize_runs(REPO, [_wf_run(10)], {10: [_job("pos/static", 1, 501)]},
                                        [{"id": 501, "app": {"id": 777}}])
        self.assertEqual(records[0]["app_id"], 777)

    def test_missing_check_run_means_no_producer(self):
        records = github.normalize_runs(REPO, [_wf_run(10)], {10: [_job("pos/static", 1, 501)]}, [])
        self.assertIsNone(records[0]["app_id"])

    def test_run_from_another_repository_has_no_trusted_workflow(self):
        records = github.normalize_runs(REPO, [_wf_run(10, repo="evil/fork")],
                                        {10: [_job("pos/static", 1, 501)]},
                                        [{"id": 501, "app": {"id": 15368}}])
        self.assertIsNone(records[0]["workflow_path"])

    def test_all_runs_completed(self):
        self.assertTrue(github.all_runs_completed([_wf_run(1), _wf_run(2)]))
        self.assertFalse(github.all_runs_completed([_wf_run(1), _wf_run(2, status="in_progress")]))
        self.assertFalse(github.all_runs_completed([]))


def _review(body, login="human", user_type="User", state="APPROVED", commit=HEAD):
    return {"user": {"login": login, "type": user_type}, "body": body, "state": state, "commit_id": commit}


class ApprovalsFromReviewsTests(unittest.TestCase):

    def test_review_with_attestation_line(self):
        body = f"LGTM\npolicy-change-approved: base={BASE} fingerprint={FP}\n"
        [a] = github.approvals_from_reviews([_review(body)])
        self.assertEqual(a, {"login": "human", "actor_type": "User", "kind": "review",
                             "head_sha": HEAD, "base_sha": BASE, "fingerprint": FP})

    def test_review_without_line_or_dismissed_is_ignored(self):
        line = f"policy-change-approved: base={BASE} fingerprint={FP}"
        self.assertEqual(github.approvals_from_reviews([_review("LGTM")]), [])
        self.assertEqual(github.approvals_from_reviews([_review(line, state="DISMISSED")]), [])
        self.assertEqual(github.approvals_from_reviews([_review(line, state="CHANGES_REQUESTED")]), [])

    def test_malformed_attestation_is_ignored(self):
        bad = [f"policy-change-approved: base={BASE[:39]} fingerprint={FP}",
               f"policy-change-approved: fingerprint={FP}",
               f"  quoted > policy-change-approved: base={BASE} fingerprint={FP}"]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(github.approvals_from_reviews([_review(body)]), [])

    def test_bot_review_keeps_its_type(self):
        body = f"policy-change-approved: base={BASE} fingerprint={FP}"
        [a] = github.approvals_from_reviews([_review(body, login="kemetra-agent[bot]", user_type="Bot")])
        self.assertEqual(a["actor_type"], "Bot")


if __name__ == "__main__":
    unittest.main()
