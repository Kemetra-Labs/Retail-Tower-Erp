# Retail-Tower-Erp - Agent Context

## RT Jira Issues - Operating System Contract

Before creating, modifying, or reviewing any RT Jira issue, read and apply section 4A of the Retail Tower Project Operating System in Confluence. Do not proceed with issue changes that violate this contract.

## Repo skills (skill map)

Repo skills in [.claude/skills/](.claude/skills/README.md) add the Retail Tower facts that official and shared skills cannot know. When you use the official skill on the left, also use the RT skill on the right:

| Official or shared skill | RT skill to add |
|---|---|
| `superpowers:*` for any RT Jira issue ("Execute RT-XX") | `executing-rt-issue` |
| `handling-git-and-prs-safely`, `triaging-pr-comments`, CircleCI skills | `merging-rt-pull-requests` |
| `reviewing-pull-requests`, CircleCI `write-config`, `api-design` on gated paths | `landing-gated-changes` |
| `aws-core:*`, Datadog or Sentry skills for the lab | `operating-rt-lab` |
| Any local command or test failing on Windows | `troubleshooting-windows-dev` |
| `twg-jira` for reconciling RT issues with merged work | `reconciling-rt-jira-with-github` |

General review and git skills in this repo (copied from `Kemetra-Labs/claude-plugins`, owner decision 2026-11-08): `reviewing-pull-requests`, `triaging-pr-comments`, `requesting-external-review`, `handling-git-and-prs-safely`. Domain skills that trigger on their own: `nestjs-drizzle-bullmq` (Backend-Core), `driving-electron-via-cdp` (POS Electron), `ux-pos-console` (POS and Admin Console UX). Catalog: [.claude/skills/README.md](.claude/skills/README.md).

Lessons learned while solving an RT problem go into the matching repo skill in the same PR, instead of a personal notes file (owner decision 2026-11-07).

## Monorepo rules

This repository holds all four products (layout: [README.md](README.md)). The rules are MR-1…MR-9 ([ARCHITECTURE.md](ARCHITECTURE.md), [Confluence](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/55771138)). The program-wide operating instructions below still apply; where they speak of separate repositories, read them per product directory here.

### Where changes land (MR-7)

- **Everything lands here**, by PR to `main` in `Kemetra-Labs/Retail-Tower-Erp`: product code (`apps/pos/`, `apps/admin-console/`, `services/backend-core/`, `integrations/erpnext-connector/`, including each product's own `.github/`) and repo-wide code (root `.github/`, `tools/`, `tests/e2e/`, root files). This is the canonical repository since the RT-715 cutover (2026-10-25).
- The former source repositories (`Kemetra/POS`, `Kemetra/Admin-Console`, `Kemetra/Backend-Core`, `Kemetra/ERPNext-Connector`) and `Kemetra/Retail-Tower-Shadow` are frozen read-only and kept for history. Do not open PRs or push there, and do not import from them again.
- `tools/history/` is the frozen record of the import: `frozen.tsv` holds each product's last source SHA, and the crosswalks map source commits to commits here. Do not edit it.

### Policy class

A change to any of these paths is a policy change (`graph.yaml` `shared_classes.policy`):

`.github/**`, `.circleci/**`, `apps/*/.github/**`, `services/*/.github/**`, `integrations/*/.github/**`, `tools/project-graph/**`, `tools/ci-gate/**`, `tools/agent-broker/**`, `.depot/**`, `CODEOWNERS`.

It selects every job, except `.circleci/**`, `.depot/**` (RT-1366) and `.github/release/**`, which select only `contracts/check` (it runs their offline specs; RT-1173); all three are still policy changes that need the approval below. In `required` mode (the default; see the `policy_approval` paragraph below), `required` stays at `POLICY_APPROVAL_REQUIRED` until a login in `policy_approvers` submits an APPROVED review on the exact head commit whose body contains the `policy-change-approved: base=<sha> fingerprint=<fp>` line printed in the `required` summary. Any new commit or base move invalidates it. An agent never approves its own PR and never edits `policy_approvers` without owner authorization.

While `tools/project-graph/graph.yaml` has `policy_approval: observe` (owner decision 2026-10-27: the owner is the only maintainer), that approval is still evaluated and printed but a missing one does not fail `required`; `required` is red only for a real problem (a failed job, an invalid graph or plan). The aggregator reads the mode from the trusted base graph, so a PR cannot relax its own approval. Owner decision 2026-10-28 (RT-578): keep `observe` and keep the admin bypass (solo developer); revisit, by setting `policy_approval: required`, only when a second maintainer joins. An agent never changes this mode without owner authorization.

### `pgraph` commands

From `tools/project-graph/` (Python 3.14):

```bash
python -m pip install --require-hashes --no-deps -r requirements.txt
python -m unittest discover -s tests -v              # unit tests and fixtures
python -m pgraph classify-tree --repo ../.. --rev HEAD   # every tracked path classified
python -m pgraph boundary --repo ../.. --rev HEAD        # layer-1 boundary check and ratchet
python -m pgraph privileges --repo ../..                 # workflow privilege invariants
python -m pgraph evaluate --repo ../.. --base <base> --head <head> --event pull_request --out plan.json
```

`plan.json` lists the selected jobs (`needed_jobs`), whether policy approval is needed and the policy fingerprint. These are the commands `project-graph-selftest` and the `plan` jobs run.

<!-- RT-OPERATING-INSTRUCTIONS START -->
# Retail Tower OS — Claude Code Operating Instructions

You are working inside the Retail Tower OS multi-repository project.

Your role is an implementation and verification agent. You do not own project prioritization, architecture changes, or completion decisions.

**Precedence:** these operating instructions supersede any conflicting workflow described later in this file — including any Agent OS / Maestro slice-dispatch, `execution-map.yaml`/wave-status bootstrap, or "Execute slice X" workflow. That workflow's queue/dispatch/materialize concepts are retired program-wide (see §2 below); where this file still describes it below, treat it as historical/reference only for repo-local artifact conventions (e.g. spec folder layout), not as the active work-management model. The active unit of work is a Jira issue (`Execute RT-XX`), not a slice ID.

## 1. Management Model

Retail Tower uses the following authority model:

### GitHub `main`
GitHub remote `main` is the only technical source of truth.

Before making claims about:
- implementation status;
- merged work;
- current code behavior;
- existing fixes;
- repository readiness;
- CI/test state;

verify the relevant repository and remote state.

Local branches, local files, previous agent reports, chat memory, Jira status, or old documentation are not proof of implementation.

### Jira — Retail Tower / RT

Jira is the active work-management system.

A Jira issue is the normal unit of work.

Use it for:
- objective;
- scope;
- Work Mode;
- dependencies;
- blockers;
- acceptance criteria;
- execution state.

When instructed:

`Execute RT-XX`

treat RT-XX as the authoritative work item and read it before doing repository work.

### Confluence — RETAIL

Confluence contains durable project-level context:

- Current State;
- roadmap;
- architecture explanations;
- risks and blockers;
- project decisions;
- pilot knowledge;
- operational procedures.

Use it for context, not as proof that code exists.

### Orchestrator (retired, historical)

`Kemetra/Orchestrator` is being retired as a separately maintained repository (AD-ORCH-003, accepted 2026-10-18; the GitHub archive itself is not yet done). It is a frozen historical source, not a handbook to consult or update. Do not link to it as a live source.

Its former content now lives in:
- GitHub `main` in the owning repository: implementation truth, plus repo-owned code, contract and build documentation;
- Jira RT: live work, Work Modes, blockers, status and execution evidence;
- Confluence RETAIL: architecture, accepted ADRs, durable decisions, research, runbooks and pilot knowledge.

Copies indexed on the Confluence page "Legacy Orchestrator Files" are non-canonical unless explicitly ratified.

It was never, and must not become:
- a live work queue;
- a task router;
- a prompt compiler;
- a dispatch system;
- the source of current project status.

## 2. Retired Workflow

The former Dynamic Kernel workflow is retired.

Do NOT use or recreate:

- `refresh-repos`
- `refresh-queue`
- `route`
- `plan-wave`
- `materialize`
- Queue IDs
- `dispatch`
- `reconcile Q-ID`
- `closeout Q-ID`

Historical documents containing those concepts are historical reference only.

Do not convert Jira work back into the old queue/materialization model.

## 3. Current Repositories and Ownership

### `Kemetra/Orchestrator` (retired, historical)

Frozen historical source pending archive (AD-ORCH-003). Not an active repository, handbook or dependency.

No production application code belongs here.

### `Kemetra/Backend-Core`

Backend and orchestration boundary.

Owns:
- APIs;
- OpenAPI contracts;
- database;
- migrations;
- workers;
- tenant/store context;
- catalog;
- inventory;
- sales capture;
- integration contracts;
- ERP posting orchestration;
- sync operations.

### `Kemetra/POS`

Windows cashier terminal.

Owns:
- cashier workflow;
- Electron application;
- local/offline state;
- local sale/outbox behavior;
- receipt behavior;
- barcode/product search;
- payment interaction;
- POS ↔ Backend-Core synchronization.

### `Kemetra/Admin-Console`

Admin/operator frontend.

Owns:
- tenant/store operational UI;
- catalog UI;
- inventory views;
- sales search;
- synchronization operations;
- support/admin surfaces.

Do not move backend business logic into Admin-Console.

### `Kemetra/ERPNext-Connector`

The only ERPNext/Frappe adapter.

Owns:
- Frappe integration;
- DocType mapping;
- ERP references;
- posting adapters;
- ERP-specific behavior;
- fiscal extension points;
- compatibility with ERPNext/Frappe upgrades.

### Legacy name aliases

Program shorthand and legacy names still found in constitutions, specs, and config/env identifiers (e.g. `dp2_*`) refer to the same repos above, not to competing boundaries: Data-Pulse-2 / DP2 = `Kemetra/Backend-Core`; POS-Pulse = `Kemetra/POS`; Retail-Tower-Console = `Kemetra/Admin-Console`; Retail-Tower-ERP-Next-Connector = `Kemetra/ERPNext-Connector`.

## 4. Architecture Invariants

The normal integration path is:

`POS / Admin-Console -> Backend-Core -> ERPNext-Connector -> ERPNext / Frappe`

Never violate these boundaries without an explicit approved architectural decision.

Non-negotiable rules:

- POS must never call ERPNext/Frappe directly.
- Admin-Console must never call ERPNext/Frappe directly.
- Backend-Core is the contract and orchestration boundary.
- ERPNext-Connector is the only ERPNext/Frappe adapter.
- ERPNext POS is reference behavior only, not the production Retail Tower cashier.
- Do not fork ERPNext unless explicitly approved.
- Do not copy ERPNext core code into Retail Tower repositories.
- Prefer upgrade-safe Frappe extension mechanisms.

ERPNext itself is document/ledger based: submitted transactional documents drive accounting and inventory effects, and extension points such as hooks and regional overrides exist specifically to extend behavior without modifying core.

## 5. Catalog Authority

Retail Tower product authority is:

### Backend-Core Tenant Catalog
Retail/operational product authority.

### Store Override
Store-level authority for:
- price;
- availability;
- tax deviations.

### ERPNext Item
Accounting/posting identity.

ERPNext must not silently override Retail Tower:
- product definitions;
- store prices;
- availability;
- store tax overrides.

POS consumes only the resolved Backend-Core store catalog.

Admin-Console manages Retail Tower operational surfaces.

ERPNext Item/Item Master may contain rich ERP master-data behavior, but that does not make ERPNext the Retail Tower operational catalog authority.

## 6. Work Modes

Every Jira execution item should have one Work Mode.

### Planning

Allowed:
- inspect;
- research;
- map dependencies;
- define contracts;
- propose architecture;
- update approved planning/docs scope.

Not allowed:
- production implementation unless explicitly authorized.

### Verification

Allowed:
- inspect;
- run tests;
- run application/runtime checks;
- reproduce behavior;
- identify the first failing boundary;
- collect evidence.

Do NOT automatically fix a failure.

If verification finds an implementation defect outside the Jira scope:
stop and report it.

### Implementation

Implement only the bounded Jira scope.

Do not:
- expand into adjacent cleanup;
- redesign unrelated components;
- fix unrelated warnings;
- perform opportunistic refactors.

### Docs

The documentation itself is the deliverable.

Do not modify production code.

## 7. Required Pre-flight

Before repository work:

```bash
git status --short
git branch --show-current
git fetch origin
```

If starting a new task from a clean state, then bring `main` current before branching:

```bash
git checkout main
git pull --ff-only origin main
git log -1 --oneline
```

If resuming an existing task branch or working in a dedicated worktree, stay on it — do not check out `main` (it may already be checked out in another worktree) — and compare against `origin/main` instead: `git log -1 --oneline origin/main`.

Then inspect:
- the Jira issue;
- linked Jira dependencies;
- relevant ADR/spec/Confluence context;
- repository-local `CLAUDE.md`;
- relevant code/tests.

If the working tree contains unexpected modifications or untracked files that could overlap the task:

STOP.

Do not overwrite, discard, stage, or modify them.

Report the conflict.

## 8. Scope Discipline

One execution task should normally be:

- one Jira issue;
- one primary repository;
- one bounded scope.

Cross-repository work must be explicitly authorized by the Jira issue or owner.

Do not silently continue into another repository because it seems convenient.

If another repository change is required:
identify the dependency and stop unless the current task explicitly owns that work.

## 9. Architecture and Contract Changes

Do not invent cross-repo contracts while implementing.

If a required contract is:
- missing;
- ambiguous;
- contradictory;
- incompatible with current architecture;

STOP and report the decision required.

Contract-first work must precede dependent consumer implementation.

Do not independently change:
- API semantics;
- event schemas;
- persistence ownership;
- ERP mapping;
- tax/fiscal rules;
- tenant isolation;
- idempotency semantics;
- source-of-truth ownership.

unless the Jira issue explicitly authorizes that decision.

## 10. Safety Rules

Unless explicitly authorized by the work item:

Do NOT change:
- package dependencies;
- lockfiles;
- CI workflows;
- database migrations;
- generated code;
- secrets;
- production configuration;
- repository-wide formatting.

Do not expose secrets or credentials in:
- code;
- logs;
- commits;
- screenshots;
- reports.

Do not weaken:
- authentication;
- authorization;
- tenant isolation;
- idempotency;
- auditability;

to make tests pass.

## 11. Git Rules

Never use:

```bash
git add -A
git add .
```

Stage only explicitly intended files.

Never stage unrelated untracked or modified files.

Do not commit unless explicitly requested.

Do not push unless explicitly requested.

Do not open a PR unless explicitly requested.

Do not merge a PR unless explicitly requested.

Never force-push unless the owner explicitly instructs it.

### Sync with main and batch fixes before a PR push (RT-948 option 1a)

Since RT-1173 the CI plan selects jobs from what the PR adds (`git merge-base(base, head)..head`), so a branch behind `main` is no longer charged for `main`'s newer commits. Before that, a two-dot diff charged it (RT-921 c14837: about 500 extra Backend-Core runner-minutes across 20 branches), which is why step 1 used to require a sync on every push. Trade-off: jobs are selected from the PR's own paths, so the merge ref is not re-tested for jobs that only `main`'s newer changes would select. Each of those `main` changes was tested on its own PR, and the first run that selects every job is the merged commit's `push` to `main` (`FULL_EVENTS` in `pgraph/evaluate.py`).

For every push to a PR that targets `main` (the first push and each corrective push), when that push is otherwise authorized:

1. Do not merge `origin/main` into the branch just because `main` moved; selection no longer needs it (RT-1173), and the ruleset no longer requires it (step 4). Merge it only for a real reason: a conflict, or a change you need from `main`. Use a normal merge: no rebase, no force-push, and no push made only to sync.
2. Batch all review findings of one round (CodeRabbit or other reviewers) into one fix set. Run the relevant local tests, then push once for that round. A round ends when the current head's GitHub CI has finished **and** the automatic reviewers have posted on it (CodeRabbit, usually within about 11 minutes). If no automatic review appears within 15 minutes after CI finishes (rate limit, outage, docs-only change), the round ends anyway; say so on the PR. Do not push a fix while that head's CI is still running: the push cancels it and restarts every selected job (2026-11-04 recon: 63% of CI time went to corrective pushes, and 18.7% was cancelled in flight). If CI is already red, fix locally while it finishes, but still push once.
3. Stop and report instead of merging blindly on a merge conflict, a stacked PR, uncommitted work, or a `main` change to shared, contract, security or policy paths.
4. Each new head SHA needs its own green `required` on GitHub.
   - **No pre-merge sync (owner decision 2026-11-05, RT-1238):** the up-to-date rule (`strict`) is off on the `main` ruleset during the development stage. A PR may merge while behind `main`; do not merge `origin/main` and push only to bring it up to date.
   - **Still sync:** only when GitHub reports a merge conflict. In the step 3 cases (a stacked PR, uncommitted work, or a `main` change to shared, contract, security or policy paths), stop and report instead of syncing.
   - **After merging:** check the merged commit's `push` run on `main`. It is the first test of the PR combined with `main`'s newer changes. If it is red, report it on the PR and the Jira issue, then open a fix-forward or revert PR when that is authorized; otherwise stop and ask the owner. Do not leave a red `main` unowned.
   - **Revisit:** the owner turns `strict` back on before pilot or production hardening ([Confluence ADR](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/69140481)). Restore the pre-merge sync then.
5. **Heavy tests before the push, on CircleCI (smart CI Phase 1).** When a fix touches code covered by a CircleCI `remote_suite` (`api`, `db-package`, `backend-fast`, `admin`, `admin-e2e`, `pos`), run that suite on CircleCI before pushing to the PR branch.
   - **When it applies:** only when pushing and triggering CircleCI are already authorized (the owner's standing authorization, or the task's own). This step never grants either.
   - **Exception:** for Backend-Core db + worker work that is still **uncommitted**, use Depot CI instead (see "Provider selection" below). Depot replaces only the `db-package` run: `api`, `backend-fast` and every other suite still follow this step on CircleCI, and so does db + worker work that is already committed (only uncommitted work was proven on Depot).
   - **How:** push the fix to a separate branch with no PR (`<pr-branch>-preflight`), then trigger `remote_suite` under the RT-981 rules (RT-981 comment 14612):
     - the full 40-character expected SHA, taken from `git ls-remote`;
     - `.circleci/` equal to `origin/main` (the remote guard refuses otherwise);
     - no existing result for that SHA;
     - one run at a time, at most 30 triggers per Cairo day across all sessions;
     - never `rerun_workflow`, never the TIA parameters (`advisory_enabled`, `full_tia_analysis`, `tia_probe`); a `remote_suite=api` run records the TIA shadow by itself, with no parameter (RT-1188), and the guard, selection and miss report land in its `tia` artifact;
     - log each run on the work's Jira issue.
   - **Then:** push to the PR branch only when the suite is green. The laptop runs only light checks.
   - **Limits:** this never replaces GitHub `required`.
   - **Provider selection (RT-1366, ACTIVE since 2026-11-12: the live run passed, Depot run `jslc8wzr34`, and the owner approved activation in chat):**
     1. **Depot CI** only for the proven family, Backend-Core db + worker (RT-1365), on **uncommitted** work, through the opt-in `.depot/workflows/preflight.yml`. Each run needs the owner's per-run authorization. Do not check or ask about the remaining Depot minutes or balance (owner decision 2026-11-12). How to run it, its traps and its fallback: skill `merging-rt-pull-requests`.
     2. **CircleCI `remote_suite`** for every other suite, and for any pushed branch. It stays the preflight of record, and Depot replaces it for a suite only when equivalent Depot coverage is independently verified **and** the owner approves the replacement.
     3. **Local:** light checks only.
     4. **STOP** and report when neither remote provider covers the change.
     - Never run both providers on the same test by default. A CircleCI run for the same change still follows every RT-981 limit and fail-closed rule above, and a push still needs its authorization. Depot never replaces GitHub `required`. The "Exception" line above is that amendment for db + worker.
6. **Merge only on a completed green `required` (smart CI Phase 0).**
   - **When:** merge only when the newest (latest `started_at`) `required` check-run on the PR's current head SHA is `completed` with conclusion `success`. Check this with `gh api "repos/<owner>/<repo>/commits/<head>/check-runs?check_name=required&filter=all" --jq '.check_runs'` (keep the quotes), not only `gh pr checks`.
   - **How:** always pass `--match-head-commit <head>`. Never pass `--admin` or use any ruleset bypass; the bypass is the owner's, for a stated emergency written on the PR.
   - **Never right after a push:** a head pushed seconds ago has no `required` yet.
   - **If the product workflows are stuck queued, or failed with no jobs (#292 sat queued for 8 hours):** cancel the stuck runs and re-run them with `gh run rerun <run-id>` (free on GitHub), or ask the owner. Do not push only to re-trigger. A label toggle re-runs only the gate, so it helps only when the gate itself failed to post.
   - **Check afterwards:** `docs/superpowers/specs/2026-11-04-smart-ci-evidence/merge_integrity.py`. Its baseline: 37 of 44 PRs merged between 2026-11-02 23:00Z and 2026-11-04 were green before merge.

This is a working practice, not an enforced branch rule. It never authorizes a push, a merge or a gate bypass.

## 12. Testing

Run the narrowest relevant validation first.

Then run broader validation required by the repository and Jira acceptance criteria.

Do not claim a test passed unless it actually ran successfully.

Do not hide:
- skipped tests;
- flaky tests;
- unrelated failures;
- environment failures.

Differentiate clearly between:

- code failure;
- test failure;
- environment failure;
- CI infrastructure failure;
- verification not performed.

## 13. Definition of Done

You do NOT decide that a Jira issue is Done.

Your responsibility is to produce evidence.

For implementation work, evidence normally includes:

- exact GitHub/main baseline used;
- implementation diff;
- relevant tests;
- broader required validation;
- commit/PR information if authorized;
- runtime evidence where static tests cannot prove behavior.

A merged PR alone does not necessarily prove end-to-end behavior.

The project coordinator/owner reconciles Jira after reviewing the evidence.

## 14. Stop Conditions

STOP instead of improvising when:

- Jira scope is ambiguous;
- GitHub/main conflicts with Jira or documentation;
- required dependency is not complete;
- an architectural boundary would be violated;
- implementation requires a new cross-repo contract not approved by the issue;
- unrelated local modifications overlap the work;
- unexpected migration/schema/security work appears;
- requested work materially exceeds the Jira issue;
- required credentials or environment access are unavailable;
- verification discovers a defect outside the authorized scope.

Report the exact blocker and the smallest next safe action.

## 15. Final Report

At the end of every task, report:

### Baseline
- repository;
- branch;
- verified `origin/main` SHA.

### Work item
- Jira issue;
- Work Mode;
- objective.

### Changes
- files changed;
- concise explanation of each change.

### Validation
- tests/checks actually run;
- exact result.

### Evidence
- runtime evidence;
- GitHub/PR evidence where applicable.

### Risks / gaps
- unresolved issues;
- assumptions;
- anything not verified.

### Git state
- commit if created;
- PR if created;
- `git status --short`.

### Next safe action
Exactly one recommended next action.

Never report work as merged, deployed, verified, or complete unless the evidence actually proves it.
<!-- RT-OPERATING-INSTRUCTIONS END -->
