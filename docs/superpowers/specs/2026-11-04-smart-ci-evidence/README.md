# Smart CI recon evidence (2026-11-04)

This folder holds the evidence behind `../2026-11-04-smart-ci-design.md`:

- `REPORT.md`: the findings;
- the derived CSVs;
- the one-off scripts that produced them;
- `merge_integrity.py` and its tests: the maintained Phase 0 checker.

The scripts are a **frozen snapshot of a one-off analysis**, kept so that every number can be traced. They are not maintained tools. The raw API cache, about 15 MB, is not committed, so re-running needs a fresh fetch.

## Inputs and run order

Every data-processing script below takes the data folder `S` as `sys.argv[1]`; the repo root comes from `RT_WORKTREE`, and defaults to this checkout. `merge_integrity.py` is different: it reads GitHub directly, e.g. `python merge_integrity.py --repo Kemetra-Labs/Retail-Tower-Erp --merged-since 2026-11-04T00:00:00Z --limit 60`.

| Step | Produces | How |
|---|---|---|
| 1 | `prs40.json` | The pinned sample: #253–#262, #264–#293 (#263 is not in it; 40 PRs merged 2026-11-02 23:22Z–2026-11-04 08:24Z). Rebuild it with `gh pr view <n> --json number,title,headRefName,headRefOid,mergedAt,createdAt,baseRefName,changedFiles` for each of those numbers, joined into one JSON array. Do not use `gh pr list --limit 40`, which drifts as new PRs merge. |
| 2 | `runs.json` | One flat JSON array of run objects. For each 4 h window from 2026-11-02 22:00Z to 2026-11-04 10:00Z (re-fetch hourly where a window hits the 1000-result cap), run `gh api --paginate "repos/Kemetra-Labs/Retail-Tower-Erp/actions/runs?created=<from>..<to>&per_page=100" --jq '.workflow_runs[]'`. Then combine every page and window, dedupe by `id`, into an array: `… \| jq -s 'unique_by(.id)' > runs.json`. The API returns pages of objects with a `workflow_runs` field, not an array (external command). |
| 3 | `jobs/<run>.json` | `fetch_jobs.py` |
| 4 | `pr_reviews/`, `pr_comments/`, `issue_comments/`, `pr_commits/` | `fetch_meta.py`, `fetch_meta2.py` |
| 5 | `pr_base.json` (PR_BASE from plan-job logs) | `fetch_base.py`, then `fetch_base2.py` |
| 5b | the sampled commits in the local repo | Squash-merged and superseded heads are not on any branch. `git fetch origin 'refs/pull/<n>/head:refs/ci-recon/<n>'` for each sampled PR, plus every head SHA in `runs.json` (`git fetch origin <sha>`). Verify each head and each PR_BASE with `git cat-file -e <sha>^{commit}` before step 6. |
| 6 | `shas.json`, `jobs.csv`, `jobs.json` (first pass, no checks yet) | `build_data.py` |
| 7 | `cr_all/<sha>.json` (all check-runs per head; reads `shas.json`), then **run `build_data.py` again** to attach them | `fetch_cr_all.py`, `build_data.py` |
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
- **Head `required` state is simplified.** `build_data.py` keeps the first successful `required` run per head. `summ5.py` and `term_check.py` compare against it. A head whose `required` failed and then passed on a rerun, or whose newer run was pending at merge, can be misclassified. The sample has 5 reruns. For any merge-time claim, `merge_integrity.py` (newest run started before the merge decides) is the authoritative tool; `term_check.py` is a cross-check only.
- **Bot attribution is correlation**, not proof of cause.
