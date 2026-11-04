# CI recon: where GitHub Actions time goes (Retail-Tower-Erp, last 40 merged PRs)

Written by a read-only subagent (Sonnet, high effort) on 2026-11-04. The main session independently recomputed the headline totals from `jobs.csv`: 5,837.2 runner-min, 1,094.1 cancelled, 40 PRs. Times are UTC unless marked Cairo. Runner-min is the sum of each job's started_at..completed_at over all attempts, cancelled jobs included, not rounded to billing minutes. Raw data and scripts are in this folder.

## 0. Sample
- The 40 most recent merged PRs (#253, merged 2026-11-02 23:22Z, to #292, merged 2026-11-04 08:24Z). Pushes span about 25.5 h (first 2026-11-02 22:56Z, last 2026-11-04 00:24Z) and merges about 33 h, in an agent-heavy sprint, so the shares are indicative.
- 123 head SHAs: 40 first pushes and 83 corrective pushes. 25 of the 40 PRs had at least one corrective push.
- 1,242 workflow runs and 4,468 job records, of which 3,055 executed.

## 1. Headline
| Metric | Value |
|---|---|
| Runner time, all heads | 5,837 runner-min (97.3 h); mean 146, median 97 per PR |
| First pushes / corrective pushes | 2,143 (36.7%) / 3,694 (63.3%) |
| Final head of each PR / earlier heads | 2,251 (38.6%) / 3,586 (61.4%) |
| Cancelled in flight | 1,094 runner-min (18.7%) |
| Heads that never got a completed `required` | 48 of 123 (39%) |
| Reruns (run_attempt > 1) | 5 runs, 112.7 runner-min (1.9%) |
| Always-on overhead (plan x9, gitleaks, selftests, boundary-check, dependency-review, gate) | 811 runner-min (13.9%), on ~99% of heads |

By product: Backend-Core 2,482 (42.5%), POS 1,381 (23.7%), Admin-Console 825 (14.1%), always-on 811 (13.9%), e2e/smoke 175 (3.0%), Connector 113 (1.9%).

## 2. Jobs
| Job | Heads run | Runner-min | Share | Cancelled part | Median success (min) |
|---|---|---|---|---|---|
| bc/schemathesis (4 shards) | 53 | 1,709 | 29.3% | 568 | 8.5 per shard |
| pos/test (3 shards) | 61 | 758 | 13.0% | 39 | ~4 |
| admin/e2e | 56 | 648 | 11.1% | 171 | 14.0 |
| bc/db-integration | 53 | 320 | 5.5% | 85 | 6.9 |
| plan (9 workflows) | 122 | 294 | 5.0% | 36 | 0.23 (+0.8 queue) |
| bc/db-package | 53 | 247 | 4.2% | 43 | 5.0 |
| pos/package-windows | 44 | 198 | 3.4% | 7 | 4.5 |
| pos/static | 61 | 188 | 3.2% | 9 | 3.0 |
| admin/build-test | 56 | 177 | 3.0% | 10 | 3.3 |
| e2e/smoke | 93 | 175 | 3.0% | 5 | 1.9 |
| project-graph/selftest | 122 | 152 | 2.6% | 15 | 1.2 |

## 3. Wall-clock (75 heads where `required` completed)
- **push → required:** median 14.9 min, p90 26.4, max 39.9.
- **By push type:** first pushes median 17.7 min; corrective pushes median 14.1 min.
- **Critical path:** the last workflow to finish is usually POS (35 heads) or Admin (18); admin/e2e is the longest single job at 14 min.
- **Merged without a completed `required`:** 7 of 40 PRs had no completed `required` on their final head. Stale "waiting" check-runs make this metric noisy.

## 4. Corrective pushes (83)
- **Cost and timing:** 3,694 runner-min; the median gap to the previous push is 11.4 min.
  - 47 of the 83 arrived before the previous head's `required` had completed (compared by time; the first count, 41, used the eventual state and was corrected after review).
  - 36 of the 83 had no earlier green head.
- **CodeRabbit timing:** CodeRabbit reviews land a median 5.6 min after each push (p90 11.0), usually mid-CI.
- **Strict attribution:**

| Cause | Pushes | Runner-min |
|---|---|---|
| Bot-driven | 41 | 2,060 (56% of corrective) |
| Pure main-merge (nothing new from the PR) | 26 | 1,100 |
| Neither | 16 | 534 |

- **Sync rule:** 37 of the corrective pushes include a merge of origin/main (the RT-948 rule). Stale-base over-selection is negligible: 1 head, 0.8 min.

## 5. Failures and flakes
- **Failures:** 15 failed job executions; 52.5 runner-min spent on failed jobs.
- **Reruns:** 5 reruns cost 112.7 min. 4 proved to be flakes (connector/bench, pos shards 2 and 3, admin/build-test); 1 was real (pos shard 3 on #281).
- **Unclassified:** the 10 gate/evaluate failures were not classified.

## 6. Selection drivers (real pgraph evaluator replay; 71 of 75 gated heads match exactly)
- **select-all:** 24 heads in 9 PRs, 2,294 runner-min = **39.3% of all CI**.
  - Policy class on 22 heads: `.github/release/**` 33 path hits, `.circleci/**` 14, workflows 11.
  - System class (`system/releases/**` manifests) on 12 heads.
  - PR #268 (`draft_manifest.py` under `.github/release/`): 7 select-all heads, 651 min. The single-file manifest PRs #261 and #287 cost 99 and 125 min.
- **Breadth:** bc-full on 57 heads (47%), pos-full on 61 (50%), admin/e2e on 57, e2e/smoke on 97.
- **What triggers the heavy BC jobs:** untiered Backend-Core "high" paths (34 heads, including test-only files), policy 22, BC contracts tier 15, system 12.
- **Semantic edges:** BC contracts, money, sales and posting-sync changes pull in POS static and test plus the 3 shards on 17 heads (270 min).
- **Incidental files** (what-if, removed from the diff):

| Path class | Heads where removal changes selection | Runner-min |
|---|---|---|
| `services/backend-core/changelog.d/**` | 0 of 20 (always with BC code) | 0 |
| BC `docs/**` (PR #270, high tier by design) | 10 | 362 (6.2%) |
| POS `docs/**` | 36 | 47 |
| PIN / generated | 2 | 23 |
| All incidental together | 49 heads, 12 PRs | 475 (8.1%) |

## 7. Corrective-push counterfactual (ESTIMATE)
| Variant | Definition | Saved runner-min | % of all CI |
|---|---|---|---|
| V1 | Diff from the last green head, naive | 163 | 2.8% |
| V2 | V1, restricted to the PR's own paths | 847 | 14.5% |
| V3 | Job-level anchor, naive | 344 | 5.9% |
| V4 | V3 + V2 restriction | 1,055 | 18.1% |

- **Why naive barely helps:** main merges drag main's changes into the anchor diff, and 36 corrective pushes have no green anchor at all.
- **V2/V4 assumption:** they assume the merged main commit was green. 4 of 47 merge events pulled a main commit whose POS push run was red.
- **Wall-clock:** median saving is about 0, because the critical-path job usually stays selected.

## 8. Levers visible (no design)
- **select-all:** 39.3% of runner-min.
- **Cancelled in flight:** 18.7%.
- **Always-on:** 13.9%.
- **Pure main-merge pushes:** 1,100 min.
- **Untiered BC high paths:** pull in all of bc-full.
- **BC→POS edges:** 270 min.
- **Bot reviews:** arrive mid-CI.

## 9. Not measured
- **CircleCI:** credits not measured (the lane is paused).
- **Cost:** no billing-rounded minutes or money.
- **Gate failures:** the 10 gate/evaluate failures were not classified.
- **Missing base:** 2 heads have no recoverable base.
- **Flake vs real:** provable only where a rerun exists.
- **Push time:** approximated by the first workflow-run created_at.
- **Sample:** an agent-heavy window (about 25.5 h of pushes, 33 h of merges).
- **Scope:** nightly, deploy and main-push workflows are outside it.
