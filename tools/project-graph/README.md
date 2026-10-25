# tools/project-graph

The project graph, fail-closed evaluator, `required` aggregator and layer-1 boundary check for the private, **non-authoritative** `Kemetra/Retail-Tower-Shadow` (RT-721 Substep A).

The design comes from [RT-709 §A](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/43548700) and [§B](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/43778136), hardened by A.8 (R1, R2, R5).

**Status: staged, not operational and not security-verified.** Nothing here is wired as a required check. App installation, the `ci-gate` environment and the ruleset are RT-721 Substep B, and each needs separate owner authorization. Independent verification is RT-711.

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
| `pgraph/privileges.py` | R5 / T-A static check of root and staged workflows (`python -m pgraph privileges`) |
| `boundary-todo.yaml` | Boundary ratchet (one entry, RT-715). Entries may only be removed; a stale entry fails `boundary` |
| `fixtures/` | P01–P19 (RT-709 A.6) and X01–X08 (new, see below) with hand-written expectations |
| `tests/` | unittest suite, including the fixture runner and a real-tree acceptance check |
| `../ci-gate/gate.yml.staged` | T-A gate template, kept outside `.github/workflows` |

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

1. It checks out history only and extracts `tools/project-graph` from the **trusted** commit with `git archive` (the PR base; the pushed commit on `push` to `main`). Head code is never run; the head tree is read as git data, as in the gate.
2. It runs `python -m pgraph evaluate` with the PR's base and head SHAs and outputs `needed_jobs` as the JSON output `jobs`. A push to `main` is `FULL_RUN_EVENT` and selects everything. An invalid trusted graph selects nothing, so the plan job fails loudly instead.
3. Every graph job outside `always_jobs` has `needs: plan` and `if: contains(fromJSON(needs.plan.outputs.jobs), '<key>')`. The jobs it needs are guarded on its key too: the POS shards also run for `pos/test`, and the Schemathesis shards run for `bc/schemathesis`.

`boundary-check` and `dependency-review` are `always_jobs` and stay unguarded.

**Plan-guard rule (static rule 5b).** `validate_graph(..., workflows=...)` checks the trusted root workflows. It fails the graph (`GRAPH_INVALID`, select all) on any of these:
- `CI_JOB_UNGUARDED`: a graph job, or a job it needs transitively, does not need `plan` or lacks a guard on that key;
- `CI_PLAN_MISSING`: the workflow has no unconditional `plan` job with a `jobs` output;
- `ALWAYS_JOB_GUARDED`: an always-run job has a guard.

Only the canonical guard shape is accepted (see `guard_keys`), so `always() || ...` is rejected. `tests/test_real_tree.py` asserts the rule on the committed tree, and fixture X08 covers the negatives.

**Policy paths inside products.** Policy classes are checked before product ownership, and only a `policy_change` class may reach into a product root (rule 2), so a product path matched by `policy` never becomes `AMBIGUOUS_PATH`. The boundary check still treats such paths as product code (`Graph.product_of`). `apps/*/.github/**`, `services/*/.github/**` and `integrations/*/.github/**` are `policy` (root jobs execute scripts from there, e.g. `fetch-pinned-contracts.sh`). They landed in a separate PR after the rule-2 relaxation, because the gate validates a proposed graph with the base validator.

**Semantic edges.** Backend-Core `sales`, `money` and `posting-sync` also select `pos/static` and `pos/test`. Connector `posting-sync` also selects `bc/fast`.

## Approval protocol (R1)

A policy change passes only with an **APPROVED** pull request review on the exact head commit. GitHub does not let a PR's author approve their own PR, so self-approval is impossible. COMMENTED reviews never count. The review is valid only if it meets all of these:

- It comes from a `User` login listed in the **trusted** (base) `policy_approvers`.
- Its body contains this line exactly:

  ```
  policy-change-approved: base=<base sha> fingerprint=<plan.policy_fingerprint>
  ```

The fingerprint covers the base SHA, both graph hashes and every changed path/mode/blob. Any new head commit, base move or content change invalidates the approval. Labels never approve; they only re-trigger the gate.

`policy_approvers` is `[Kemetra]` (RT-721 S1, owner decisions c13766/c13770). Accepted residual, Shadow only: agents still act under the same `Kemetra` token, so an approval by this login cannot be proven human. Full R1 separation (agents on `kemetra-agent`) is a cutover precondition before RT-715.

## Credential matrix (R5)

| Workflow | Triggers | Token permissions | Environment | Secrets |
| --- | --- | --- | --- | --- |
| `.github/workflows/project-graph-selftest.yml` | `pull_request`, `push` main | `contents: read` | none | none |
| `tools/ci-gate/gate.yml.staged` (inactive) | `pull_request_target`, `workflow_run` | `contents/pull-requests/checks/actions: read` | `ci-gate` (main-only) | `CI_GATE_APP_PRIVATE_KEY`, used only in the last step; App token scoped to `checks: write` |
| Product CI (`pos`, `admin-console`, `backend-core`, `erpnext-connector`, `e2e`, `project-graph`) | `pull_request`, `push` main | `contents: read` | none | none |
| Per-product releases (RT-717) | protected `main` / tags only | product-specific identity | per-product environment | never reachable from PR code |

`python -m pgraph privileges` enforces these rules for every workflow reachable from a PR:
- No `write` scope, and permissions must be declared.
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
8. **Staged gate: Needs verification.** Two behaviours are unconfirmed:
   - whether a `pull_request_target` run's `head_sha` makes it appear in `actions/runs?head_sha=` (the gate excludes its own workflow path regardless);
   - whether the source pin accepts a `checks:write` App check (A.8).
9. **Root LICENSE and NOTICE are deferred** (OA-5, OA-6, OA-7). Not added.

### Review findings recorded, not fixed (2026-10-19 code + security review)

All HIGH findings were fixed test-first (`tests/test_review_fixes.py`). These lower ones stay open:

10. **`boundary_review` is a flag only.** A cross-product rename sets it, but nothing blocks on it. Whether it should require approval is an owner decision.
11. **Ratchet additions are controlled only by the `policy` class.** Closed by RT-873: a stale entry now fails `boundary` (`ok: false`, exit 1). Still open: a `(rule, from, to)` entry also covers any later violation with the same triple.
12. **Layer-1 path detection is lexical (RT-873).** Closed: non-import JS/TS path literals, `*.config.*`, JSON `extends`, `.vue`/`.svelte`, Python `Path(__file__)` climbs and climbing literals, and `boundary --rev` reading blobs at the rev. Still open, by design of a regex scan: paths built by `+` concatenation, computed segments, `os.path.dirname` chains, and Frappe routes split across literals are not seen. A climbing literal with an unknown base (cwd, a `ROOT` constant) is resolved against every directory from the file up to the product root; it is reported when one of them reaches another product, or when it leaves the product even from the file's own directory. The MR-6 egress rule (`erp-egress`, `apps/**` only) matches a literal only when the whole literal is a `/api/resource/<x>` or `/api/method/<x>` route (optionally behind a scheme+host or a leading `${...}`), so UI copy and test deny-lists do not match. Layer 2 (RT-873 layer 2) waits for cutover.
13. **Approvers are matched by login.** Matching by numeric user id would survive renames and recycled logins.
14. **Dismissing a review does not re-trigger the gate.** A `pull_request_review` trigger would run workflow code from the PR merge ref. A green `required` stays until the next push or label event.
15. **The gate does not re-run `privileges` on head workflows.** That is defence in depth only; the primary control is that `.github/**` and `tools/ci-gate/**` are `policy` paths.
16. **`required` and stale bases.** `required` is posted per head SHA against the PR's base SHA, so the ruleset must also require "branches up to date" (in the activation checklist).
