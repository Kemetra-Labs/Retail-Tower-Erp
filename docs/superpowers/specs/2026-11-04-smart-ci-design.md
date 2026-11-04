# Smart CI: less waiting, same or better quality (design)

Status: APPROVED by the owner 2026-11-04 (later the same day amended with the verified root cause in §3.0 and the owner-directed §4.5). Author: Claude, with the owner. The goal and the trade-offs below are the owner's; every evidence number comes from the read-only recon of 2026-11-04 (40 merged PRs from #253 to #293, merged 2026-11-02 23:22Z to 2026-11-04 08:24Z, 123 pushed heads, GitHub Actions only). Each item that touches a policy-class path (`.github/**`, `.circleci/**`, `tools/project-graph/**`, `tools/ci-gate/**`) needs its own owner-approved Jira issue and PR. This document authorizes none of them.

## 1. Intent

The owner wants a "smart CI" for all four products (POS, Admin Console, Backend-Core, ERPNext Connector), with one "brain" deciding what runs for each push. The aim is to cut wall-clock waiting and CI load while keeping quality equal or higher.

The owner's balance is **time and quality first**. Runner minutes and CircleCI credits are secondary: they are a gain, not the target.

### 1.1 Goals
- **G1. A trustworthy gate.** No PR is merged without a completed, green `required` on its exact head. Today the gate itself is the weakest link (§3.0).
- **G2. Fewer CI cycles per PR.** Remove the loops that re-run CI without new information: syncing with `main` mid-PR, and pushing review fixes while CI is still running.
- **G3. Narrower selection where it is safe.** Only the rules the evidence shows are over-broad.
- **G4. Shorter critical path** (POS chain, `admin/e2e`) once G1–G3 are done.
- **G5. One brain.** The trusted Project Graph (`graph.yaml` + `pgraph`) stays the single decision source. It is reused, not duplicated.

### 1.2 Non-goals
- Test-level selection inside the **gate** (CircleCI TIA, RT-949 `api_jest_fast`). Neither ever decides `required`. TIA gets a defined role in the **pre-push run** instead (§4.5, owner direction 2026-11-04). Its promotion stays with RT-920 evidence and an RT-921 decision.
- Changing the gate's trust model, the `policy_approval` mode, the trusted producer, or the vendor (D-CI-2026-10-29 §6).
- Enabling GitHub Merge Queue. It is out of scope unless separately designed (D-CI-2026-10-29 §5).

### 1.3 Anti-goals (a failure even if it technically works)
- A green `required` on a commit whose changed risk was not tested.
- Any PR merged on a stale, cancelled, missing or `in_progress` `required`.
- Lower coverage, security or contract thresholds; fewer tests in the inventory.
- A second routing system next to the Project Graph.

## 2. Evidence summary (recon 2026-11-04)

The full report, the derived CSVs and the analysis scripts are kept next to this document in `2026-11-04-smart-ci-evidence/`. The raw API cache (about 15 MB) is not committed; the scripts re-fetch it.

| Finding | Number |
|---|---|
| Runner time over 123 heads | 5,837 runner-min (97 h) |
| Spent on corrective (non-first) pushes | 63% (3,694 min) |
| Cancelled in flight | 18.7% (1,094 min) |
| Corrective pushes following a review-bot finding (strict) | 41 of 83 (2,060 min) |
| Pushes that are only a merge of `main` (nothing new from the PR) | 26 (1,100 min) |
| "Select-all" heads (policy class `.github/**` / `.circleci/**`, system manifests) | 24 heads / 9 PRs = 39.3% of all CI |
| Always-on jobs (9 × `plan`, selftests, gitleaks, gate…) | 13.9% |
| `bc/schemathesis` (4 shards × ~8.5 min) | 29.3% of runner time, runs whenever bc-full is selected |
| push → `required`, median / p90 | 14.9 / 26.4 min; critical path POS chain (35 heads) or `admin/e2e` 14 min (18) |
| PRs merged with no completed `required` on the final head | 7 of 40 |
| Flakes / reruns | 1.9%, a minor cost |
| `changelog.d/**` effect on GitHub selection | none (always ships with code) |

## 3. Root causes (verified in code and on GitHub)

### 3.0 The gate does not always finalize `required` (quality)
- **#273 (head `941cb30c`) and #268 (`b779d097`):** every product workflow and `gate/evaluate` / `gate/post` succeeded. The `required` check-runs on the head still stayed `in_progress` ("required: waiting", created 14:33:25 and 14:38:26, after `gate/post` finished at 14:33:18). Both PRs were merged by an admin.
- **#292 (`6fe5d173`):** 9 of its 10 workflows concluded `failure` with no jobs (a startup failure; GitHub returned 504s in the same window). It was merged with no CI at all.
- **Mechanism (`gate.yml`):** the gate runs on `pull_request_target` and on each product workflow's `workflow_run`, with `concurrency: gate-<head_sha>`. It posts `required: waiting` (`in_progress`) while runs are pending.
- **Verified root cause (2026-11-04, after the first draft): PRs were merged before CI finished.** The gate behaved correctly; the earlier gate-race hypothesis is disproved.
  - **The gate saw it:** the gate run for #273's last `workflow_run` (run 41656685451) logged "PR #273 is already merged" and correctly posted nothing.
  - **All 7 were merged by `Kemetra`, the owner account that agent sessions also use:**

| PR | Merged (UTC) | Last CI finished |
|---|---|---|
| #264 | 12:37:36 | 12:44:00 |
| #266 | 12:11:41 | 12:11:58 |
| #268 | 14:43:09 | 14:46:34 |
| #270 | 14:44:13 | 15:08:33 |
| #273 | 14:43:45 | 14:44:32 |
| #292 | 08:24:14 | 08:24:16 |
| #262 | 12:11:56 | 12:11:53 (the gate had not posted yet) |

  - **#292 was merged 2 s after its last push.** Its workflows then failed to start (9 failures with no jobs), so that head never had any CI.
  - **Why the merges were possible:** no ruleset requires `required` (RT-866 open), so a merge succeeds while `required` is `in_progress`.
  - **The fix is enforcement, not gate code.** Missing, `in_progress` and red `required` must all block a merge.

### 3.1 Mid-PR syncing with `main`
- **How selection works today:** the `plan` job selects jobs from `git diff <pull_request.base.sha> <pull_request.head.sha>` (two-dot; `pgraph/gitio.read_changes`). The base is the current tip of `main`.
- **Why that over-selects:** a branch that is behind `main` has `main`'s newer changes counted as its own. RT-948 option 1a works around this by requiring a merge of `origin/main` before each push. That is 37 merge pushes, 26 of which bring nothing new from the PR (1,100 min).
- **What the jobs actually test:** they check out GitHub's default `refs/pull/N/merge`, so they already test the PR merged onto `main`. Only the selection is stale-sensitive, not the test subject.
- **What stays justified:** the pre-merge freshness rule (RT-948 step 4: green `required` on a head that includes current `main`). It protects the merge result.

### 3.2 Review-fix pushes land mid-CI
- **The timing:** CodeRabbit reviews a median 5.6 min (p90 11) after each push, while CI is still running. Agents push the fix immediately, so the running CI is cancelled (18.7% of minutes) and a new full cycle starts. 41 of 83 corrective pushes follow a bot finding.
- **Root cause:** working practice. There is no rule to wait for both the CI result and the review, and then push one combined fix.

### 3.3 Over-broad selection rules
- **Policy class selects every job.** `.github/release/**` (release tooling with its own `release/selftest`) and `.circleci/**` (advisory only, never feeds `required`) select all 22 jobs. Example: PR #268 (`draft_manifest.py`) had 7 select-all heads costing 651 min.
- **System class selects every job.** A single JSON release manifest cost 99 min (#261) and 125 min (#287). The guard that matters for a manifest is `contracts/check`, which runs the system release gate G1–G5 on every manifest. The releases a manifest names were already built and tested on their own release tags.
- **Untiered Backend-Core paths are "high".** They select all 6 `bc/*` jobs, schemathesis included, even for test-only files (34 heads).
- **Policy changes must still require owner approval.** Selection breadth and approval are separate questions.

### 3.4 Fixed per-PR overhead
Each of the 9 root workflows evaluates the same graph in its own `plan` job (294 min, plus about 1 min queue each). Selftests and gitleaks also run on about 99% of heads (13.9% in total).

### 3.5 Long jobs on the critical path
`admin/e2e` takes 14 min; the POS chain is static, then 3 test shards, then packaging. `bc/schemathesis` is the largest load but usually not the longest path.

## 4. Design (ordered; each phase is its own Jira issue and PR, measured before the next)

### Phase 0: Gate integrity (G1) — must ship first
1. **Root cause found (done during design):** merges before CI finished; see §3.0. No gate code change is needed for G1.
2. **Agent merge rule (CLAUDE.md, written).** An agent merges only when the `required` check-run on the PR's current head SHA is `completed` with conclusion `success`. It pins the merge to that SHA (`--match-head-commit`), never uses `--admin`, and never merges seconds after a push.
3. **Merge enforcement (owner decision 2026-11-04: ruleset, bypass kept).**
   - A repository ruleset on `main` requires the `required` check (RT-866 scope, its own issue and approval).
   - The owner keeps the admin bypass (RT-578), for stated emergencies only, with the reason written on the PR.
   - Agents never use the bypass.
- **Acceptance:**
  - Negative tests show that the race, a startup failure, a cancelled run and a missing run can never leave `required` green, missing or stuck.
  - The next 20 merged PRs all have a completed green `required` on their final head.

### Phase 1: Stop wasted cycles (G2) — biggest time win, small code
1. **(1a) Selection from the merge-base.**
   - **Change:** `plan` (and the gate's re-evaluation, which must stay identical) computes changes from `git merge-base(base, head)` to `head`. That is exactly what the PR adds to `main`, and matches what `refs/pull/N/merge` tests.
   - **Fail-safe:** if the merge-base cannot be resolved, select everything (fail closed).
   - **Approval binding unchanged (my call):** only the selection diff moves to the merge-base. The policy-approval line, its fingerprint and the aggregator's `--base` keep binding to `pull_request.base.sha`, exactly as today, so the trust model and approval semantics (§1.2) do not change.
   - **Where:** `tools/project-graph/**` and every root `plan` step; policy class.
2. **(1b) Retire mid-PR syncing.** Amend RT-948 so that a push no longer needs a merge of `main` for selection reasons. Keep the pre-merge freshness rule (step 4) in a narrower, still conservative form:
   - **When it applies (my call, the conservative reading):** before merging, compute what `main` added since the green head's merge-base. If that selects **any** job at all, merge `origin/main` and get a fresh green `required`. Only a `main` change that selects no job (docs, for example) is exempt.
   - **Not the weaker reading:** "only when it selects a job this PR also selects" is rejected. It would let a `main` change in product X merge untested next to a PR in product Y.
   - **Interaction with the CircleCI pre-push run:** its remote guard refuses a branch whose `.circleci/` differs from `origin/main`; a branch behind a `.circleci/` change on `main` must sync first (rare).
   - **Who enforces it:** the merge practice and the merge check of Phase 0 (§6 Q1). A head's `required` does not turn red on its own when `main` moves, so it has to be checked at merge time.
3. **(1b) One fix push per review round.**
   - Agents wait until the head's CI has finished **and** the reviewers have posted (CodeRabbit usually within 11 min). They collate every finding, fix locally, run the relevant local tests, then push once (this extends the existing RT-948 step 2).
   - Superseded runs are still cancelled by the existing concurrency groups; that behaviour does not change.
   - CodeRabbit keeps reviewing every push automatically; its settings do not change (owner decision 2026-11-04). The saving comes from batching, not from fewer reviews.
- **Acceptance:**
  - On 10 merged PRs, the average number of pushed heads per PR and the cancelled-minute share fall measurably against the recon baseline (3.08 heads/PR = 123/40, 18.7%).
  - No PR merges without Phase 0's guarantees.
  - Replaying the recon heads with merge-base selection never selects fewer jobs than the PR's own changes require.

### Phase 2: Narrower rules where safe (G3) — `graph.yaml` (policy class)
0. **Schema extension first (prerequisite).** `pgraph/graph.py` only allows a shared class to select `all`, `[e2e]` or `[]`. Phase 2 first extends the schema so a shared class can select a named job list, with validation and selftest fixtures.
1. **Split the policy class into "needs approval" and "what it selects".**
   - Keep `policy_change: true` for every policy path.
   - **Before any narrowing:** turn the offline checks those paths rely on into gated graph jobs that feed `required`. That means `release/selftest` (today in `project-graph-selftest.yml`, advisory and outside the gate's `workflow_run` list) and the `.circleci/scripts` offline tests. Narrowing never leaves a policy path guarded only by an advisory check.
   - **Set `selects` per path group (my call):**
     - `.github/release/**`, shared files included (`manifest.py`, `draft_manifest.py`, `system_gate.py` …): the gated release selftest only. Release tooling is executed by release and deploy workflows, never by product test suites, so running product suites for it adds no quality.
     - `.circleci/**`: its own gated offline tests only. It never feeds `required`.
     - `.github/workflows/**`, `.github/actions/**`, gate code, graph code and everything else in the class: still `all`.
2. **System class (my call):** `system/releases/**` selects the fixed list `contracts/check` + `e2e/smoke`, not all. There is no content-aware reading of the manifest.
3. **Backend-Core untiered paths:** introduce a `low`/`tests-only` treatment.
   - **Covered:** spec files under `apps/api/test/**` and `changelog.d/**`.
   - **"Helpers" (my call):** exactly the `api_jest_fast` exclude list (`apps/api/test/_helpers/**`, `apps/api/**/*.d.ts`, `apps/api/src/main.ts`), plus Jest config and setup files. Helpers stay high.
   - **What they select:** `bc/fast` + `bc/db-integration`, not schemathesis, oasdiff or contracts-compat.
   - **Precondition:** the RT-582 content check (no code quotes the path) is a separate prerequisite issue inside Phase 2. Until it ships, this rule stays fail-closed and Phase 2.3 is skipped.
4. **Run a what-if replay before merge.** Each rule change ships with a replay of the recon corpus through the real evaluator. It shows which heads change selection, and the PR reviewer checks every narrowed head by hand.
- **Acceptance:** the replay is attached; each rule has a negative fixture showing a risky path still selects the full suite.

### Phase 3: Less fixed overhead (G5) — trust-model neutral only
- **No shared plan artifact (my call).** Sharing one plan between workflows needs a trusted producer that runs before the product workflows. None exists: the gate runs after them, and `pull_request` output is untrusted. It would also break the gate's "no artifact is downloaded" invariant. Both are excluded by §1.2.
- **Scope:** only changes that leave the trust model as it is. Examples: a lighter `plan` step (sparse checkout and a cached pinned `pip` install), selftests limited to changes of their own paths, and fewer queue minutes. If measurement shows the gain is negligible, Phase 3 is dropped.

### Phase 4: Shorter critical path (G4) — measure first
- **Profile first.** Profile `admin/e2e` (14 min) and the POS chain before changing anything.
- **Candidate levers, each needing its own evidence:**
  - shard `admin/e2e`;
  - start the POS tests without waiting on `pos/static`, if the dependency is not needed;
  - run schemathesis shards only for contract, auth or money tiers, or keep all 4 but only on the final head. The latter is only allowed if Phase 0 guarantees the final head is green before merge.

### 4.5 How it fits together: one system, three roles (owner direction 2026-11-04)

The owner wants an integrated system, with CircleCI and TIA used, not idle. Each part has one job:

| Part | Role | Decides a merge? |
|---|---|---|
| Project Graph (one brain) | Decides which product jobs a change needs | It feeds the gate |
| GitHub Actions `required` | The quality gate: the full selected suites on the exact head | **Yes, the only authority** |
| CircleCI pre-push run (`remote_suite`) | Fast feedback **before** a push, so the push arrives clean and corrective loops shrink (63% of CI time today) | No |
| TIA inside the pre-push run | Learns which API specs a change touches. Later, it makes the pre-push run faster | No |
| RT-1075 guard | Forces a full pre-push run whenever the PR's whole diff touches risk | No |

**Flow for an agent fix:**
1. Local light checks.
2. Push to `<pr-branch>-preflight` (no PR), then run `remote_suite` on CircleCI.
3. When it is green, push once to the PR branch.
4. The gate runs the graph-selected suites.
5. Merge on a completed green `required` (Phase 0).

**Phase 1c: TIA shadow inside the pre-push run.**
- **What runs:** every `remote_suite=api` run also runs the RT-1075 guard, `circleci testsuite list-tests` and the RT-1083 shadow report next to the full suite, like the paused advisory job does.
- **Why it is cheap:** each pre-push run then is both a check and an RT-920 measurement (D2: only TIA_ELIGIBLE PRs count), with no extra pipeline.
- **Impact data:** it needs fresh impact data from the main-only analysis job (`backend-api-jest-analysis`). Re-enable that job on `main` merges with a monthly credit cap, which is grant use with lasting value.
- **Needs:**
  - a `.circleci/config.yml` change (policy class);
  - an owner amendment of the RT-981 rule "never the TIA parameters", for the pre-push run only;
  - the credit cap, written into the issue.

**Phase 5 (later, only after RT-920 evidence): TIA speeds up the pre-push run.**
- **Trigger:** 10 distinct TIA_ELIGIBLE PRs with zero observed misses, then an RT-921 KEEP decision.
- **Change:** the pre-push run uses `--run-tests=impacted` when the guard says TIA_ELIGIBLE, and the full suite otherwise.
- **The gate does not change:** it still runs the full selected suites, so quality cannot drop. A miss would be caught by the gate, cost one extra push, and be recorded.

## 5. Constraints
- **Repo rules:** CLAUDE.md, the monorepo rules MR-1…MR-9, the policy class and approval flow, and D-CI-2026-10-29 apply in full.
- **Authority:** GitHub Actions `required` stays the only merge authority.
- **Scope of each phase:** one Jira issue, one primary area, a bounded scope, and the owner's review.
- **Measurement:** before/after use the recon method (scripts kept with the evidence) on at least 10 merged PRs per phase. No savings claim without measured data.
- **CircleCI:** the advisory lane stays paused; this design does not depend on it.

## 6. Decided vs left open
**Decided by the owner (this conversation):**
- Time and quality are the priority over raw minutes.
- One brain, the Project Graph.
- Corrective-push loops are a primary target.
- Every change keeps the quality red lines in §1.3.

**My calls (owner to confirm while reading):**
- **Order:** Phase 0 first.
- **Selection:** merge-base selection replaces mid-PR syncing; approval binding stays on `pull_request.base.sha`.
- **Pre-merge freshness:** the conservative reading, where any job selected by `main`'s change requires a sync.
- **Policy narrowing:** only after `release/selftest` and the `.circleci` tests become gated graph jobs. Shared release tooling then selects only that selftest.
- **System manifests:** a fixed list (`contracts/check` + `e2e/smoke`), not content-aware.
- **Backend-Core helpers:** the `api_jest_fast` exclude list plus Jest config/setup. RT-582 is a prerequisite issue.
- **Phase 3:** no shared plan artifact; trust-model-neutral trims only.
- **Schemathesis:** cut via tiers, not dropped.

**Owner decisions after the builder check (2026-11-04):**
- **Integrated system (§4.5):** GitHub `required` stays the gate; a CircleCI pre-push run and TIA inside it are added (owner: "add it", "TIA needed too"). The `CLAUDE.md` RT-948 steps 2, 5 and 6 carry the agent rules.
- **Q1:** a ruleset requires `required` on `main`; the owner keeps the admin bypass for stated emergencies; agents never bypass.
- **Q2:** CodeRabbit keeps auto-reviewing every push; agents batch fixes after CI and the review finish.

**Left to the builder:** exact implementation of each phase, test fixtures, and Jira issue wording under section 4A of the Operating System.
