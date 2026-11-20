# tools/project-graph

The project graph, fail-closed evaluator, `required` aggregator and layer-1 boundary check for `Kemetra-Labs/Retail-Tower-Erp`, the canonical monorepo since the RT-715 cutover (built in RT-721 Substep A).

The design comes from [RT-709 §A](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/43548700) and [§B](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/43778136), hardened by A.8 (R1, R2, R5).

**Status: operational, observe-only, not independently verified.** The plan jobs use the evaluator to select which jobs run (RT-867), and `.github/workflows/gate.yml` posts the `required` check with its own `GITHUB_TOKEN` (`checks: write`) from the `ci-gate` environment (RT-721 S3; no `kemetra-ci-gate` App since the owner decision of 2026-10-25). Making `required` a required check on `main` (S6 no-bypass ruleset) is RT-866, still open. Independent verification is RT-711.

**Policy approval mode.** `graph.yaml` `policy_approval` is `required` (the default when the key is absent, and the meaning of any value other than exactly `observe`) or `observe`. Under `observe` the approval is still evaluated and printed in the gate summary and in the result's `approval` block (`mode`, `valid`, `problems`), but a missing approval no longer fails `required`: every selected job, the graph validation and the plan are judged as before, and a policy change still selects all jobs (except `.circleci/**`, `.depot/**` and `.github/release/**`, which select only `contracts/check`, where their offline specs run: RT-1173). The aggregator reads the mode from the **trusted base graph**, so a PR cannot relax its own approval, and changing it is itself a policy change. It is `observe` since the owner decision of 2026-10-27 (the owner is the only maintainer, the same reasoning as advisory CODEOWNERS). Owner decision 2026-10-28 (RT-578): keep `observe` and keep the admin bypass (solo developer); revisit, by setting `policy_approval: required`, only when a second maintainer joins. While observing, nothing requires a human attestation on `.github/**` or `tools/project-graph/**`. `observe` also relaxes the attestation the evaluator asks for when a path is unknown to the trusted graph but classified by the proposed one (`UNKNOWN_IN_TRUSTED_ONLY`); that case already needs a graph change, which is itself a policy change.

## Layout

| Path | What |
| --- | --- |
| `graph.yaml` | Schema v1 graph. Single source for job selection, tiers and boundary edges. `policy` class |
| `pgraph/globs.py` | Anchored glob dialect (A.1) |
| `pgraph/graph.py` | Strict loader (size cap; no anchors, aliases or duplicate keys), static rules 1–6 plus the RT-867 plan guard, classification |
| `pgraph/evaluate.py` | A.2 evaluator: metadata in, `plan.json` out. Never runs PR code |
| `pgraph/aggregate.py` | A.5 `required` decision with R2 provenance and R1 SHA-bound approval |
| `pgraph/github.py` | REST payloads → aggregator records (jobs `filter=all` joined to check-runs; review attestations) |
| `pgraph/boundary.py` | B.1 layer-1 cross-product reference check (dependency-free `scan`), hardened by RT-873 |
| `pgraph/gitio.py` | Git plumbing adapter (`diff --raw -z`, `ls-tree`, `cat-file --batch`); no checkout |
| `pgraph/privileges.py` | R5 / T-A static check of the root workflows (and any `tools/ci-gate/*.staged` file) (`python -m pgraph privileges`) |
| `boundary-todo.yaml` | Boundary ratchet (one entry, RT-715). Entries may only be removed; a stale entry fails `boundary` |
| `fixtures/` | P01–P19 (RT-709 A.6) and X01–X08 (new, see below) with hand-written expectations |
| `tests/` | unittest suite, including the fixture runner and a real-tree acceptance check |
| `../../.github/workflows/gate.yml` | T-A trusted gate that posts `required` (moved from `tools/ci-gate/` in RT-721 S3) |

## Commands

```bash
cd tools/project-graph
python -m pip install --require-hashes --no-deps -r requirements.txt
python -m unittest discover -s tests -v
python -m pgraph classify-tree --repo ../.. --rev HEAD
python -m pgraph boundary --repo ../.. --rev HEAD
python -m pgraph evaluate --repo ../.. --base <base> --head <head> --event pull_request --out plan.json
```

## Selective execution (RT-867, MR-4)

The graph decides which jobs **execute**, not only which results `required` counts. Each root product workflow (`pos`, `admin-console`, `backend-core`, `erpnext-connector`, `e2e`) starts with a `plan` job:

1. It checks out history only and extracts `tools/project-graph` from the **trusted** commit with `git archive` (the PR base; the pushed commit on `push` to `main`; the main commit a nightly or manual full run started on, see "Nightly full CI"). Head code is never run; the head tree is read as git data, as in the gate.
2. It runs `python -m pgraph evaluate` with the PR's base and head SHAs and outputs `needed_jobs` as the JSON output `jobs`. A push to `main`, a nightly `schedule` and a manual `workflow_dispatch` are `FULL_RUN_EVENT` and select everything. An invalid trusted graph selects nothing, so the plan job fails loudly instead.
3. Every graph job outside `always_jobs` has `needs: plan` and `if: contains(fromJSON(needs.plan.outputs.jobs), '<key>')`. The jobs it needs are guarded on its key too: the POS shards also run for `pos/test`, and the Schemathesis shards run for `bc/schemathesis`.

`boundary-check` and `dependency-review` are `always_jobs` and stay unguarded.

**Plan-guard rule (static rule 5b).** `validate_graph(..., workflows=...)` checks the trusted root workflows. It fails the graph (`GRAPH_INVALID`, select all) on any of these:
- `CI_JOB_UNGUARDED`: a graph job, or a job it needs transitively, does not need `plan` or lacks a guard on that key;
- `CI_PLAN_MISSING`: the workflow has no unconditional `plan` job with a `jobs` output;
- `CI_PLAN_NOT_SHARED`: its `plan` job does not run the shared composite action `.github/actions/pgraph-plan`, or has a `run:` step of its own (RT-1467 CI-05: the plan logic exists once);
- `ALWAYS_JOB_GUARDED`: an always-run job has a guard.

Only the canonical guard shape is accepted (see `guard_keys`), so `always() || ...` is rejected. `tests/test_real_tree.py` asserts the rule on the committed tree, and fixture X08 covers the negatives.

**Policy paths inside products.** Policy classes are checked before product ownership, and only a `policy_change` class may reach into a product root (rule 2), so a product path matched by `policy` never becomes `AMBIGUOUS_PATH`. The boundary check still treats such paths as product code (`Graph.product_of`). `apps/*/.github/**`, `services/*/.github/**` and `integrations/*/.github/**` are `policy` (root jobs execute scripts from there, e.g. `fetch-pinned-contracts.sh`). They landed in a separate PR after the rule-2 relaxation, because the gate validates a proposed graph with the base validator.

**Semantic edges.** Backend-Core `sales`, `money` and `posting-sync` also select `pos/static` and `pos/test`. Connector `posting-sync` also selects `bc/fast`.

## Nightly full CI (RT-1471 Phase 1)

The six root workflows that define the plan-guarded graph jobs (`backend-core`, `pos`, `admin-console`, `erpnext-connector`, `contracts`, `e2e`: 20 of the 22 graph jobs; the two `always_jobs` live in `project-graph.yml`, which is not scheduled) each run once a night on the tip of `main`, and on demand for one pinned SHA. Both are `FULL_RUN_EVENT`: the same job selection, thresholds and artifacts as the push to `main` that runs today. A push to `main` still runs everything; Phase 1 changes nothing about it, about PR selection, or about `required`.

| Workflow | Cron (UTC, daily) | Cairo, winter (UTC+2) | Cairo, Egyptian DST (UTC+3) |
|---|---|---|---|
| `backend-core` | `37 23 * * *` | 01:37 | 02:37 |
| `pos` | `38 23 * * *` | 01:38 | 02:38 |
| `admin-console` | `39 23 * * *` | 01:39 | 02:39 |
| `erpnext-connector` | `40 23 * * *` | 01:40 | 02:40 |
| `contracts` | `41 23 * * *` | 01:41 | 02:41 |
| `e2e` | `42 23 * * *` | 01:42 | 02:42 |

Why this slot. The six start within five minutes so they test the same commit (unless a merge lands in that window or GitHub delays one run), at an off-peak minute (GitHub delays runs at `:00` and `:30`) and finish well before the other nightlies: `api-fuzz-nightly` 02:17 UTC, `connector-bench-nightly` 02:23 UTC, `clean-stale-caches` 03:00 UTC (the weekly `trivy-backend-core`, `secrets` and `scorecard` are at 03:17, 04:43 and 05:27 UTC). The six together are the burst a merge to `main` already produces, so they share the runner pool the way a push does. `tests/test_nightly_full.py` fails if a cron stops being daily, leaves the 15-minute window, or comes within an hour of any other schedule.

What a nightly or manual run does differently from a push, and why:
- **Trust.** The `plan` action treats the run like a push: the evaluator is the commit being run. A `schedule` or `workflow_dispatch` run is accepted only on `refs/heads/main`, and a dispatch must name the SHA to prove (`expected_sha`, 40 lowercase hex). A moved `main`, a wrong SHA or another ref fails in `plan`, before any product job starts. The plan also fails unless it selected every job with a valid graph, so a nightly cannot go green on a subset.
- **Coverage artifacts.** `sonar-coverage-pos`, `-admin-console`, `-backend-core` and `-erpnext-connector` are uploaded on every non-PR run (they were push-only). The POS source-scope guard pin now runs on every non-PR run too, as the Windows unpacked-build artifact upload already did. Thresholds are unchanged: they run in the same steps.
- **Backend-Core `bc/oasdiff`.** A push compares with `github.event.before`; a scheduled or manual run has none, so it compares the tip with its first parent (the comparison the tip's own push run made). A commit with no first parent fails; it never compares nothing.
- **Concurrency.** Non-PR runs are grouped per event and SHA, so a manual run never cancels, or is cancelled by, the push run of the same commit.
- **Gate.** `gate.yml` ignores `workflow_run` on `main`, so these runs never post or change `required`. They add check-runs for the tip SHA under the same names; the release compat guard reads the latest `github-actions` run per name, so a nightly that is still running or flaky red on the SHA being released makes the guard refuse (fail closed); re-run that nightly workflow and release again.
- **Sonar.** `sonar.yml` still scans pushes only (it waits for `--event push` runs). Moving it onto the nightly is scope item 4 of RT-1471 (D7), a later change.

**Manual full run for one exact SHA** (the owner-authorized pre-activation proof; a billable trigger: about 156 runner-minutes, authorize each use). It dispatches the same six workflows, with the same selection, thresholds and artifacts as the schedule; it does **not** prove that GitHub fires the schedule, which only the first scheduled run does.

```bash
SHA="$(git ls-remote origin refs/heads/main | cut -f1)"   # the exact main SHA to prove; write it down
for wf in backend-core pos admin-console erpnext-connector contracts e2e; do
  gh workflow run "$wf.yml" --ref main -f expected_sha="$SHA"
done
```

Verify, per workflow (`gh run list --workflow "$wf.yml" --event workflow_dispatch --limit 1 --json databaseId,headSha,conclusion`): `headSha` equals `$SHA`; the `plan` job summary says `event: workflow_dispatch`, `select_all: true`; every graph job (`gh run view <id> --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"'`) is `success` and none is `skipped`; the four `sonar-coverage-*` artifacts exist (`gh api repos/<owner>/<repo>/actions/runs/<id>/artifacts --jq '.artifacts[].name'`, or the run page). If a run fails at `plan` with `expected_sha ... is not the commit this run started on`, `main` moved: take the new tip and dispatch again. Record the run IDs, the SHA, the job inventory and the artifacts on the Jira issue.

## `api_jest_fast` (graph data only)

The RT-949 Backend-Core API Jest shadow selector (module, `api-jest-select` and `api-jest-report`
commands, shadow steps) was retired and removed by RT-1467. `graph.yaml`
`products.backend-core.api_jest_fast` stays, validated by `graph.py` (`SCHEMA: ...api_jest_fast`,
`TIER_GLOB_OUTSIDE_PRODUCT`): `.circleci/scripts/tia-risk-guard.cjs` copies its globs, and its test
fails if they drift. A path is "fast" only if it matches these globs and is in no Backend-Core tier.

## Approval protocol (R1)

In `required` mode (see "Policy approval mode" above; under `observe` the approval is only reported), a policy change passes only with an **APPROVED** pull request review on the exact head commit. GitHub does not let a PR's author approve their own PR, so self-approval is impossible. COMMENTED reviews never count. The review is valid only if it meets all of these:

- It comes from an approver listed in the **trusted** (base) `policy_approvers`. An entry is either a plain login string (legacy; the actor must be a `User`) or `{id, type, login?}` (RT-870). An `{id, type}` entry matches the review author's immutable numeric account id **and** its type, `User` or `Bot`; `login` is only a label, so a renamed or recycled login never matches. A review with no numeric id never matches an `{id, type}` entry. Any other entry shape is a `SCHEMA` error.
- Its body contains this line exactly:

  ```
  policy-change-approved: base=<base sha> fingerprint=<plan.policy_fingerprint>
  ```

The fingerprint covers the base SHA, both graph hashes and every changed path/mode/blob. Any new head commit, base move or content change invalidates the approval. Labels never approve; they only re-trigger the gate.

`policy_approvers` lists two accounts by numeric id and type (RT-870): `Kemetra` (206601658, `User`, the owner) and `kemetra-reviewer[bot]` (348508063, `Bot`, the independent reviewer App). The reviewer's token has only `pull_requests: write` and `metadata: read`, so it can review but not push or merge; it runs in a session separate from the one that authors the PR. Agent sessions that author PRs act under the `Kemetra` token, and GitHub does not let an author approve their own PR, so an agent-authored policy PR can only be approved by the reviewer App (or merged by the owner with the admin bypass). Accepted residual: because agent sessions still hold the `Kemetra` token, an approval by `Kemetra` cannot be proven human, and it could approve a policy PR authored by another actor such as `kemetra-agent[bot]`. Full R1 separation (agents off the `Kemetra` credentials) is still open.

## Credential matrix (R5)

| Workflow | Triggers | Token permissions | Environment | Secrets |
| --- | --- | --- | --- | --- |
| `.github/workflows/project-graph-selftest.yml` | `pull_request`, `push` main (only when `tools/project-graph/**`, `.github/**`, `.circleci/**` or `.depot/**` change) | `contents: read` | none | none |
| `.github/workflows/gate.yml` | `pull_request_target`, `workflow_run` | `contents/pull-requests/checks/actions: read` | `ci-gate` (main-only) | none; `post` alone holds `checks: write` on its `GITHUB_TOKEN` |
| Product CI (`pos`, `admin-console`, `backend-core`, `erpnext-connector`, `e2e`, `project-graph`) | `pull_request`, `push` main | `contents: read` | none | none |
| Per-product releases (RT-717) | protected `main` / tags only | product-specific identity | per-product environment | never reachable from PR code |
| `.github/workflows/mirror-erpnext-connector.yml` (RT-712) | `push` main (Connector paths), `workflow_dispatch` | `contents: read`; the `connector-mirror-publisher` App token is `contents: write` on `Kemetra-Labs/ERPNext-Connector` only | `connector-mirror` (main-only, required reviewer), plus the `MIRROR_PUBLISH_ENABLED` arming variable | `MIRROR_APP_PRIVATE_KEY`, used by `publish` only |

`python -m pgraph privileges` enforces these rules for every workflow reachable from a PR:
- No `write` scope, and permissions must be declared. The one exception is `checks: write` alone, in a `ci-gate` job (the gate's `post`).
- No `secrets.*` outside a `ci-gate` job.
- In `pull_request_target`/`workflow_run`: no head-ref checkout, no `actions/cache` and no `actions/download-artifact`.

GitHub repo-scoped `contents:write` tokens have **no path restriction**, so product isolation comes from protected branches, environments and per-product identities, never from paths. The Connector publisher App is installable only on the distribution mirror (RT-712), never on this repo.

## X01–X08 (new in RT-721 and RT-867)

These were named but never defined in RT-710 comment 12882. They are **defined new here** from the RT-721 negatives, not restored:

| # | Case |
| --- | --- |
| X01 | Only the latest run/attempt counts; an older green never wins; an incomplete job after the deadline fails |
| X02 | Wrong producer App, wrong workflow path, duplicate results; a forged green cannot mask a real failure |
| X03 | Green on a stale/foreign head SHA, or from the wrong event |
| X04 | Approval at head A, then head moved to B; base moved; policy content changed (fingerprint) |
| X05 | Bot reviewer, unlisted login, label-only approval, empty approver list |
| X06 | Path dialect: case, root anchoring, NFC, unmatched-in-product = `high`, BC docs SQL, push selects all |
| X07 | Boundary: imports, `require`, dynamic `import()`, manifest `file:`, tsconfig `extends`, Python `sys.path` and relative imports, literal product paths, Dockerfile, ratchet. RT-873 adds: non-import JS/TS path literals (`path.resolve(__dirname, '../..')`, `new URL('../x', import.meta.url)`, `join(ROOT, '..', '..', ...)`, `${ROOT}/../..` templates), `*.config.*` files, JSON `extends`, `.vue`/`.svelte`, Python `Path(__file__).parents[n]` / `.parent` chains and climbing literals (`open('../../...')`), the MR-6 ERPNext/Frappe egress rule, and stale ratchet entries failing |
| X08 | RT-867 plan guard: unguarded job, missing `needs: plan`, guard on another key, always-true guard, unguarded dependency, guarded always-job, missing plan job; product `.github/**` is policy; semantic edges |

## Known gaps (named, not silently relaxed)

1. **Static rule 5 and the plan guard hold on the real tree.** Root workflows define every graph job (the last one, `e2e/smoke`, landed with RT-851), and every non-always job is plan-guarded (RT-867). `tests/test_real_tree.py` asserts there are no static-rule errors, so a job cannot go missing or start running unselected again.
2. **P15 deferred.** Merge Queue is off; `merge_group` is `UNKNOWN_EVENT`.
3. **P17/P19 are logic-level only here.** The local tests show that forged and wrong-producer results are ignored and that workflow/aggregator edits are policy changes. The real proof is GitHub running the base-branch gate and enforcing the ruleset source pin: **RT-711**.
4. **BC has no `low` tier.** The RT-582 rule (a low path quoted by code becomes high) needs a content scan that is not implemented. BC docs/specs/markdown are therefore `high` (over-selection).
5. **Layer-2 per-product boundaries** (POS process ESLint rules, Admin Biome, BC internal graph, Connector import-linter) belong to product slices and are not implemented here.
6. **Forced checks not yet in the §B.5 job map** are mapped to the nearest existing job: Admin Playwright e2e → `admin/build-test`; POS fuse readback and native-load smoke → `pos/package-windows`; BC compat matrix/replay → `bc/oasdiff`. B.4 dependency checks are one `dependency-review` job. These need real jobs before G2.
7. **e2e trigger interpretation.** `e2e_runs_when: any_product_selected` is read as "any product has a non-`low` tier", so a docs-only product change does not run e2e.
8. **Gate: Needs verification.** Two behaviours are unconfirmed:
   - whether a `pull_request_target` run's `head_sha` makes it appear in `actions/runs?head_sha=` (the gate excludes its own workflow path regardless);
   - whether the source pin accepts a `checks:write` App check (A.8). Moot since 2026-10-25: `required` is posted by GitHub Actions, so a source pin cannot separate it from another workflow's check.
9. **Root LICENSE and NOTICE are deferred** (OA-5, OA-6, OA-7). Not added.

### Review findings recorded, not fixed (2026-10-19 code + security review)

All HIGH findings were fixed test-first (`tests/test_review_fixes.py`). These lower ones stay open:

10. **`boundary_review` is a flag only.** A cross-product rename sets it, but nothing blocks on it. Whether it should require approval is an owner decision.
11. **Ratchet additions are controlled only by the `policy` class.** Closed by RT-873: a stale entry now fails `boundary` (`ok: false`, exit 1). Still open: a `(rule, from, to)` entry also covers any later violation with the same triple.
12. **Layer-1 path detection is lexical (RT-873).** Closed: non-import JS/TS path literals, `*.config.*`, JSON `extends`, `.vue`/`.svelte`, Python `Path(__file__)` climbs and climbing literals, and `boundary --rev` reading blobs at the rev. Still open, by design of a regex scan: paths built by `+` concatenation, computed segments, `os.path.dirname` chains, and Frappe routes split across literals are not seen. A climbing literal with an unknown base (cwd, a `ROOT` constant) is resolved against every directory from the file up to the product root; it is reported when one of them reaches another product, or when it leaves the product even from the file's own directory. The MR-6 egress rule (`erp-egress`, `apps/**` only) matches a literal only when the whole literal is a `/api/resource/<x>` or `/api/method/<x>` route (optionally behind a scheme+host or a leading `${...}`), so UI copy and test deny-lists do not match. Layer 2 (RT-873 layer 2) waits for cutover.
13. **Legacy string approvers are matched by login.** `{id, type}` entries (RT-870) match the immutable numeric account id and type, so they survive renames and recycled logins. A plain login string still matches by login and a `User` type, so the recycled-login risk remains only for string entries. `graph.yaml`'s `policy_approvers` no longer has any.
14. **Dismissing a review does not re-trigger the gate.** A `pull_request_review` trigger would run workflow code from the PR merge ref. A green `required` stays until the next push or label event.
15. **The gate does not re-run `privileges` on head workflows.** That is defence in depth only; the primary control is that `.github/**` and `tools/ci-gate/**` are `policy` paths.
16. **`required` and stale bases.** `required` is posted per head SHA against the PR's base SHA, so the ruleset must also require "branches up to date" (in the activation checklist).
