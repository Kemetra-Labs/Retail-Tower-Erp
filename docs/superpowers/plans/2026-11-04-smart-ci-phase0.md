# Smart CI Phase 0 (merge integrity) Implementation Plan, with Phase 1–4 roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No PR reaches `main` unless the `required` check on its exact head is completed and green. This is enforced by GitHub, not only by habit, and is measured afterwards. Freshness against a newer `main` is **not** enforced by GitHub in Phase 0; it stays the RT-948 step 4 practice (see Global Constraints).

**Architecture:**
- **Root cause:** the gate already behaves correctly (design §3.0); merges simply happened before `required` completed.
- **Phase 0 adds three things:**
  - a `required_status_checks` rule on the existing `main-pr-protection` ruleset;
  - an explicit agent merge rule in `CLAUDE.md`;
  - an offline checker that measures "green before merge" for any set of merged PRs.
- **No gate code changes.**

**Tech Stack:** GitHub rulesets REST API (`gh api`), Python 3.13 standard library + `unittest` (checker), Markdown.

**Spec:** `docs/superpowers/specs/2026-11-04-smart-ci-design.md` (approved 2026-11-04; §3.0, §4 Phase 0, §6).

## Global Constraints
- **Repo rules:** CLAUDE.md applies in full, including §10 safety rules, §11 git rules (no `git add -A`, no force-push) and the RT-948 sync and batch practice.
- **Owner approval:** repository settings (rulesets) change only with the owner's explicit approval for that exact call, under Jira RT-866 or its successor.
- **Gate:** GitHub Actions `required` (producer: `github-actions`, app id 15368) stays the only merge authority. No change to `gate.yml`, `tools/project-graph/**`, `policy_approval` or Merge Queue.
- **Bypass (owner decision Q1):** the admin bypass stays (`RepositoryRole` id 5), for owner emergencies only, with the reason written on the PR. Agents never bypass.
- **Ruleset freshness:** `strict_required_status_checks_policy` stays `false` on purpose: strict mode would force a sync push whenever `main` moved at all, which is the cost Phase 1 removes. Freshness is therefore a manual practice (RT-948 step 4 and the design's conservative rule), not a GitHub guarantee. Known exception: a PR can merge on a green `required` computed against an older `main` if an agent skips step 4; `merge_integrity.py` does not detect this. Revisit strict mode if such a case causes a red `main`.
- **Times:** report times to the owner in Cairo local time.

## Review Focus
- **Implicit bypass.** Agents act as `Kemetra`, a repo admin, and admin is a bypass actor with mode `always`. A plain `gh pr merge` (no `--admin`) might be let through anyway. Task 3 must prove a pending-`required` merge attempt is refused. If it is not, STOP and bring the owner the options (Task 3 step 4).
- **A head whose gate never posts** (workflow startup failure, as on #292). The PR must be blocked, not mergeable. It also needs a way to unblock it: `gh run rerun <run-id>` on the failed product workflows (a label re-runs only the gate). Task 3 verifies the block; Task 2 documents the unblock path.
- **Several `required` check-runs on one SHA** (a later `waiting` after a `success`). GitHub evaluates the latest one, so the PR must show as blocked while the newest is `in_progress`. Task 3 observes `mergeStateStatus` on the probe PR while `required` is pending.
- **Docs-only and bot PRs** (Renovate). They still receive a `required` from the gate on `pull_request_target`, so the ruleset must not strand them. Task 3's probe is a docs-only PR. Task 4 lists every PR that waits more than 30 min for `required` after its last workflow completes.
- **Spoofing (accepted residual).** Any workflow holding `checks:write` can post a check named `required` from the same app (gate.yml header). The policy class on `.github/**` remains the control; do not claim the ruleset closes this.

---

### Task 1: Merge-integrity checker (offline measurement)

**Files:**
- Create: `docs/superpowers/specs/2026-11-04-smart-ci-evidence/merge_integrity.py`
- Test: `docs/superpowers/specs/2026-11-04-smart-ci-evidence/test_merge_integrity.py`

**Interfaces:**
- Produces: `classify_merge(merged_at: str, required_runs: list[dict]) -> str` returning one of `GREEN_BEFORE_MERGE`, `MERGED_BEFORE_GREEN`, `NO_REQUIRED`, `RED_AT_MERGE`.
  - `required_runs` items have keys `status`, `conclusion`, `started_at` and `completed_at` (ISO-8601 Z strings, `completed_at` may be `None`), exactly as returned by `GET /repos/{o}/{r}/commits/{sha}/check-runs?check_name=required&filter=all`.
- Produces: CLI `python merge_integrity.py --repo Kemetra-Labs/Retail-Tower-Erp --merged-since 2026-11-04T00:00:00Z [--limit 50]`.
  - Prints one line per merged PR: `#<n> <class> merged=<Cairo time> head=<sha8>`.
  - Then a summary: `green_before_merge=<k>/<n>`.

- [ ] **Step 1: Write the failing tests** (`unittest`, no network). Fixtures copy the verified §3.0 facts:
  - `test_merged_while_in_progress`: `merged_at="2026-11-03T14:43:45Z"` with two runs `{"status":"in_progress","conclusion":None,"started_at":"2026-11-03T14:33:25Z","completed_at":None}`, `…14:38:26Z…`. Assert `MERGED_BEFORE_GREEN` (the #273 case).
  - `test_no_required_at_all`: `merged_at="2026-11-04T08:24:14Z"`, `[]`. Assert `NO_REQUIRED` (#292).
  - `test_green_before_merge`: one run `completed/success` with `completed_at="2026-11-03T10:50:00Z"`, `merged_at="2026-11-03T10:56:12Z"`. Assert `GREEN_BEFORE_MERGE`.
  - `test_green_after_merge_does_not_count`: `completed/success` at `14:46:00Z`, merged `14:43:09Z`. Assert `MERGED_BEFORE_GREEN`.
  - `test_latest_completed_before_merge_wins`: `success` at 10:00, then `failure` at 10:05, merged 10:10. Assert `RED_AT_MERGE`.
- [ ] **Step 2: Run:** `python -m unittest docs/superpowers/specs/2026-11-04-smart-ci-evidence/test_merge_integrity.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `classify_merge` and the CLI.**
  - **Rule:** no run at all gives `NO_REQUIRED`. Otherwise take the newest run (latest `started_at`) that started before the merge. If none did, or it had not completed strictly before the merge (`completed_at < merged_at`), the result is `MERGED_BEFORE_GREEN`. Otherwise that run decides: `success` gives `GREEN_BEFORE_MERGE`, anything else gives `RED_AT_MERGE`.
  - **CLI data source:** `gh pr list --state merged --search "merged:>=<date>" --json number,headRefOid,mergedAt` plus the check-runs call above via `subprocess` with `gh api`.
  - **Output:** ASCII only.
- [ ] **Step 4: Run the tests.** Expected: all pass (8 after the review round: also a newer `waiting` after a success, a verdict at the merge instant, and a run started after the merge).
- [ ] **Step 5: Baseline against the recon sample.**
  - Run: `python docs/superpowers/specs/2026-11-04-smart-ci-evidence/merge_integrity.py --repo Kemetra-Labs/Retail-Tower-Erp --merged-since 2026-11-02T23:00:00Z --limit 60`.
  - Expected: the 7 PRs of design §3.0 (#262, #264, #266, #268, #270, #273, #292) are not `GREEN_BEFORE_MERGE`.
  - Record the baseline line in the PR body.
- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-11-04-smart-ci-evidence/merge_integrity.py docs/superpowers/specs/2026-11-04-smart-ci-evidence/test_merge_integrity.py
git commit -m "docs: RT-866 merge-integrity checker (green required before merge)"
```

### Task 2: Agent merge rule in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`, section "Sync with main and batch fixes before a PR push (RT-948 option 1a)". Append steps 5 (CircleCI pre-push run) and 6 (merge rule) after step 4, and extend step 2 (one push per review round). Done in commit a2dac3e5 and the review-fix commit.

**Interfaces:** none (documentation). Consumed by every agent session.

- [ ] **Step 1: Add step 6 (merge rule).** It must state these points:
  - **When to merge:** only when the newest `required` check-run on the PR's current head SHA is `completed` with conclusion `success`. Check with `gh api repos/<o>/<r>/commits/<head>/check-runs?check_name=required&filter=all`, not only `gh pr checks`.
  - **How to merge:** always with `--match-head-commit <head>`; never `--admin` or any ruleset bypass. The bypass is the owner's, for stated emergencies only.
  - **Never right after a push:** never merge within the same minute as a push; wait for the new head's `required`.
  - **Missing `required`:** if `required` is missing (workflows failed to start), push nothing new just to re-trigger. Re-run the failed workflow runs with `gh run rerun <run-id>` or ask the owner; a label re-runs only the gate.
  - **Evidence:** cite `merge_integrity.py` (Task 1) as the check.
- [ ] **Step 2: Verify:** `grep -n "match-head-commit" CLAUDE.md` shows the new step; `grep -ci "never pass .--admin" CLAUDE.md` ≥ 1.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: RT-866 agents merge only on a completed green required"
```

- [ ] **Step 4: PR.** Push Tasks 1 and 2 as one PR (`CLAUDE.md` is root class and selects all, so a single PR costs one select-all run). Merge it under the Task 2 rule itself.

### Task 3: Ruleset `required` check (owner-approved repository setting)

**Files:**
- Create: `docs/superpowers/specs/2026-11-04-smart-ci-evidence/ruleset-main-pr-protection.before.json` (current state, read with `gh api repos/Kemetra-Labs/Retail-Tower-Erp/rulesets/25821989`)
- Create: `docs/superpowers/specs/2026-11-04-smart-ci-evidence/ruleset-main-pr-protection.after.json`

**Interfaces:**
- Consumes: ruleset id `25821989` (`main-pr-protection`, target `~DEFAULT_BRANCH`). Keep its existing rules (`pull_request`, `non_fast_forward`, `deletion`) and bypass actors exactly as they are.

- [ ] **Step 1: Write `after.json`.** Same as `before.json`, plus one rule:

```json
{"type": "required_status_checks",
 "parameters": {"strict_required_status_checks_policy": false,
                "do_not_enforce_on_create": false,
                "required_status_checks": [{"context": "required", "integration_id": 15368}]}}
```

- [ ] **Step 2: Owner approval.** Show the owner the diff between `before.json` and `after.json`. Get an explicit yes in chat for this exact call. Without it, STOP.
- [ ] **Step 3: Apply.**
  - Run: `gh api -X PUT repos/Kemetra-Labs/Retail-Tower-Erp/rulesets/25821989 --input <after.json body without id/source fields>`.
  - Then re-read the ruleset and confirm the new rule is present with the same bypass actors.
  - **Rollback:** `gh api -X PUT … --input before.json` (same field stripping).
- [ ] **Step 4: Negative test on a probe PR (owner-approved).**
  - Open a docs-only PR that adds `docs/superpowers/specs/2026-11-04-smart-ci-evidence/ruleset-probe.md`.
  - **While `required` is pending:** check `gh pr view <n> --json mergeStateStatus` and expect `BLOCKED`. Then try `gh pr merge <n> --squash --match-head-commit <head>` (no `--admin`) and expect a refusal.
  - **If that merge succeeds:** the admin bypass applies implicitly to agents. Revert the probe commit through a normal PR, then STOP and bring the owner the options:
    - (a) set the admin bypass to `pull_request` mode and re-test;
    - (b) remove the bypass and give the owner an emergency procedure (temporarily disable the rule);
    - (c) move agents to a non-admin identity.
  - **After `required` turns green:** expect `CLEAN`. Close the probe PR without merging and delete its branch.
- [ ] **Step 5: Record evidence.** Put the before/after JSON, the probe PR link and the observed `mergeStateStatus` values on RT-866.
- [ ] **Step 6: Commit** the two JSON files (a docs-only follow-up PR, merged under the Task 2 rule):

```bash
git add docs/superpowers/specs/2026-11-04-smart-ci-evidence/ruleset-main-pr-protection.before.json docs/superpowers/specs/2026-11-04-smart-ci-evidence/ruleset-main-pr-protection.after.json
git commit -m "docs: RT-866 main ruleset requires the required check"
```

### Task 4: Acceptance measurement

**Files:** none new (uses Task 1).

- [ ] **Step 1:** after at least 20 PRs have merged since the ruleset went live, run `merge_integrity.py --merged-since <ruleset time> --limit 50`.
  - **Expected:** `green_before_merge=20/20` or better, every exception explained by a written owner emergency bypass.
  - **Also list** each PR whose `required` took more than 30 min after its last workflow finished (Review Focus: stranded PRs).
- [ ] **Step 2:** post the output to RT-866 and the RT-708 epic. Phase 0 is accepted only by the owner.

---

## Roadmap: Phases 1–4 (one Jira issue + one plan + one PR each, written after Phase 0 is accepted)

| Phase | Jira issue (proposed title) | Scope (design §4) | Acceptance |
|---|---|---|---|
| 1a | Selection diff from merge-base | `pgraph` `read_changes` callers + every root `plan` step and the gate's re-evaluation. Diff `merge-base(base, head)..head`; select everything if the merge-base is missing. Approval line, fingerprint and `--base` unchanged. Policy class. | A replay of the recon corpus (`run_selection.py`) shows that no head selects fewer jobs than its own PR changes require. New pgraph unit fixtures cover a stale branch, a missing merge-base and a clean branch. |
| 1b | Retire mid-PR syncing; one fix push per review round | `CLAUDE.md` RT-948 text. Sync only before merge, when `main`'s change since the green head's merge-base selects any job. Wait for CI and the reviews to finish, then push one combined fix. CodeRabbit settings unchanged. | On 10 PRs: heads per PR below the 3.08 baseline and cancelled share below 18.7% (method: the recon scripts). |
| 1c | TIA shadow inside the CircleCI pre-push run (design §4.5) | `.circleci/config.yml`: the `remote-dev-api` job also runs the RT-1075 guard, `list-tests` and the RT-1083 shadow report beside the full suite. Re-enable the main-only `backend-api-jest-analysis` with a monthly credit cap. Owner amends the RT-981 "no TIA parameters" rule for this run only. Policy class. | One pre-push run on a real PR shows `guard.json`, the selection and `report.json`. Credits per run are recorded. The `required` gate is unchanged. |
| 2 | Narrower selection where safe | Schema: a shared class can select a named job list. `release/selftest` and the `.circleci` offline tests become gated graph jobs. `.github/release/**` selects only the release selftest; `.circleci/**` selects only its tests; `system/releases/**` selects `contracts/check` + `e2e/smoke`. BC tests-only tier after RT-582 (separate prerequisite issue). | A what-if replay attached. Negative fixtures show that workflows, gate and graph paths still select all. |
| 3 | Lighter fixed overhead (trust-model neutral) | A lighter `plan` step; selftests run only on changes to their own paths. No shared plan artifact. | Measured always-on minutes below the 13.9% baseline, or the phase is dropped. |
| 4 | Shorter critical path | Profile `admin/e2e` and the POS chain first, then one lever at a time (sharding, dependency trimming, schemathesis by tier). | Median push→`required` below the 14.9 min baseline on 10 PRs, with no test removed from the inventory. |
| 5 | TIA speeds up the pre-push run (only after RT-920: 10 TIA_ELIGIBLE PRs, zero misses, RT-921 KEEP) | The pre-push run uses `--run-tests=impacted` when the guard says TIA_ELIGIBLE, and the full suite otherwise. The gate is unchanged. | The pre-push median time falls. Any miss shows up as a gate failure and is recorded. |
