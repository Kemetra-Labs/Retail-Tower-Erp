# Smart CI recon evidence (2026-11-04)

This folder holds the evidence behind `../2026-11-04-smart-ci-design.md`:

- `REPORT.md`: the findings;
- the derived CSVs;
- the one-off scripts that produced them;
- `merge_integrity.py` and its tests: the maintained Phase 0 checker.

The scripts are a **frozen snapshot of a one-off analysis**, kept so that every number can be traced. They are not maintained tools. The raw API cache, about 15 MB, is not committed, so re-running needs a fresh fetch.

## Inputs and run order

Every script takes the data folder `S` as `sys.argv[1]`. The repo root comes from `RT_WORKTREE`, and defaults to this checkout.

| Step | Produces | How |
|---|---|---|
| 1 | `prs40.json` | `gh pr list --repo Kemetra-Labs/Retail-Tower-Erp --state merged --limit 40 --json number,title,headRefName,headRefOid,mergedAt,createdAt,baseRefName` (external command) |
| 2 | `runs.json` | `gh api "repos/Kemetra-Labs/Retail-Tower-Erp/actions/runs?created=<4 h window>&per_page=100" --paginate`. Windows run from 2026-11-02 22:00Z to 2026-11-04 10:00Z; a window that hit the 1000-result cap was re-fetched hourly (external command). |
| 3 | `jobs/<run>.json` | `fetch_jobs.py` |
| 4 | `pr_reviews/`, `pr_comments/`, `issue_comments/`, `pr_commits/` | `fetch_meta.py`, `fetch_meta2.py` |
| 5 | `pr_base.json` (PR_BASE from plan-job logs) | `fetch_base.py`, then `fetch_base2.py` |
| 6 | `cr_all/<sha>.json` (all check-runs per head) | `fetch_cr_all.py` |
| 7 | `shas.json`, `jobs.csv`, `jobs.json` | `build_data.py` |
| 8 | `pr_shas.json` | list of each PR's head SHAs from `shas.json` (inline) |
| 9 | `selection.json` (real `pgraph` replay) | `run_selection.py` |
| 10 | `analysis.json`, `shas.csv` | `analyze.py` |
| 11 | `counterfactual*.csv`, `cf2.json` | `cf2.py` |
| 12 | `stale_base.json` | `stale_base.py` |
| 13 | `corrective_attribution.*` | `final_stats.py` |
| 14 | printed tables | `summ1.py` … `summ7.py`, `term_check.py` |

## Known limitations (from review, 2026-11-04)

- **Snapshot timing.** `fetch_jobs.py` and `fetch_cr_all.py` skip files that already exist. A run or check that was still in progress at fetch time stays frozen in that state.
  - The fetch ran after every sampled PR had merged (the last merge was 08:24Z), so most data was terminal.
  - For a re-run, delete the cache or re-fetch the heads that are not terminal.
  - `build_data.py` counts a job with no `completed_at` as 0 minutes, so a frozen in-progress job would undercount runner time.
- **Error handling.** After review, `fetch_base2.py`, `fetch_meta2.py` and `stale_base.py` now fail loudly on a `gh` or `git` error instead of continuing with empty data. The other fetchers were not hardened.
- **Numbers corrected after review:**
  - **Pushes that arrived before the previous head's `required` completed:** 47 of 83, not 41. `summ5.py` now compares times instead of the eventual state.
  - **V1 savings on ungated heads:** these are now split into really superseded heads (38.5 min) and final heads merged before CI finished (96.2 min). Before the fix, all 134.7 min counted as superseded (`summ7.py`).
  - **Unchanged:** the validation denominator (`summ1.py`) is still 71 of 75, and `term_check.py` lists the same 7 PRs.
- **Bot attribution is correlation**, not proof of cause.
