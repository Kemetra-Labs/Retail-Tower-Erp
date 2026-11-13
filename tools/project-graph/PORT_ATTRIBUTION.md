# Port attribution — Phase 3 (advisory only)

`pgraph.port_attribution` turns **trusted Git object evidence** into direct service attribution for a Retail Tower pull request. It reads the current `tools/project-graph/graph.yaml` from an **immutable protected base commit**; it never repeats path-to-service rules, runs PR-head code, sends tokens, changes CI selection or writes to Port.

## Invocation in a future trusted, read-only collector

```bash
cd tools/project-graph
python -m pgraph.port_attribution \
  --repo ../.. \
  --base "$TRUSTED_BASE_FULL_SHA" \
  --head "$PR_HEAD_FULL_SHA" \
  --pr-number "$PR_NUMBER" \
  --out port-attribution.json
```

`TRUSTED_BASE_FULL_SHA` must come from the protected target branch, **not** the PR branch or a file supplied by the PR. Fetch both immutable commit objects, including full history needed for `git merge-base`; no shallow-history fallback, and no checkout or import of PR-head code. Verify the PR belongs to `Kemetra-Labs/Retail-Tower-Erp` and the supplied base/head match the GitHub event before invoking. A protected-base runner or independently trusted job should eventually own this collection and the write credentials; **do not put Port credentials in a `pull_request` job that executes head code**.

The classifier uses `gitio.merge_base(base, head)` and `gitio.read_changes(merge_base, head)` (raw diff, rename-aware) and reports `classification_policy_ref`, `diff_base_sha`, `head_sha`, `classification_evidence_url` and a deterministic input fingerprint. The fingerprint proves consistent local input processing, **not** that GitHub supplied the events or that a PR is approved.

## Rules and safe failure

- `affected_services` names only product paths that `Graph.classify()` recognizes. Existing graph roots and policy precedence remain authoritative; no parallel mapping table.
- A PR touching POS + Backend-Core yields **both** services. A rename across product roots includes the old and new owners. A copy affects only its new destination.
- `.github/**`, `tools/project-graph/**`, product-local `.github/**`, and other shared policy paths are **shared** changes: they may cause CI to select all jobs, but they are **not** direct changes to every product. `shared_classes` records those classes.
- An unknown/ambiguous path, type change, non-regular mode reported by the Git diff adapter, missing merge base, missing/invalid trusted graph, empty diff, invalid SHA or more than 3,000 changes returns `attribution_status=insufficient_evidence`, `attribution_scope=unknown`, **no affected services**, and an explanatory `reason_codes` value. CLI exit code is **2** in that case, **0** only for classified evidence. Never treat `[]` under `insufficient_evidence` as proof that no services changed.
- Only `A`, `M`, `D`, `R`, `C` Git raw-diff statuses are accepted. Both paths of `R` must be present; newly reported symlink/submodule and unsupported modes fail closed. The adapter reports only the new mode, so this is not a substitute for a separate audit of deleted-file old modes.

## Port integration boundary — not implemented in Phase 3

The output names match the new Port `githubPullRequest` fields and `affected_services` relation, but **this module does not upsert any entity**. A later trusted writer must verify source identity, idempotently publish the complete desired `affected_services` list, and protect against concurrent writers/resync overwrites. The old single `service` relation and all existing dashboard/scorecard semantics remain unchanged. CI validation of *executed job evidence* is a different future flow (`githubWorkflowRun.validated_services`), not a synonym for PR impact or for merely selected jobs.

## Tests

The current `.github/workflows/project-graph-selftest.yml` already executes `python -m unittest discover -s tests -v`; the new `tests/test_port_attribution.py` is discovered automatically. No changes are made to `.github/workflows/`, the evaluator, gate, graph or selected jobs.
