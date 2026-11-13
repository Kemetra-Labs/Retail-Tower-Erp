# Port sync planning — Phase 4, slice S1 (offline)

`pgraph.port_sync` decides what a future trusted writer **would** send to Port to set `githubPullRequest.affected_services`. It has no HTTP client, reads no environment variables, holds no credentials and writes nothing. Inputs are Git objects and JSON snapshots; the output is a plan. Classification is `pgraph.port_attribution`, unchanged.

```bash
cd tools/project-graph
python -m pgraph.port_sync plan --repo ../.. --main-sha "$TRUSTED_MAIN_FULL_SHA" \
  --prs prs.json --entities entities.json --services services.json --out plan.json
```

`prs.json`: GitHub snapshots `{number, state, merged, base_ref, head_sha, head_repo, merge_commit_sha}`. `entities.json`: Port `githubPullRequest` entities. `services.json`: Port `service` identifiers. All three are captured by read-only calls outside this module.

## Evidence (which diff is classified)

| PR | Base given to the classifier | Why |
|---|---|---|
| open, closed, squash- or rebase-merged | trusted `origin/main` tip, head = final PR head | `merge-base(tip, head)` is the fork point, so the whole branch is classified. A rebase merge is **not** reduced to its last replayed commit. |
| merged by merge commit (head already in main) | the merge commit's first parent, only if its second parent is the PR head | The one case where a tip-based diff would be empty. |
| head already in main otherwise, base ref not `main`, head repo not this repo | refused (`HEAD_ALREADY_IN_BASE`, `NON_MAIN_BASE`, `FOREIGN_HEAD_REPO`) | Deterministic `insufficient_evidence`. |
| missing objects, bad snapshot, classifier environment errors | no verdict (`infra`) | Never written as a result. |

## What may be written

Only the existing Port fields: `affected_services` and `attribution_scope`, `attribution_status`, `classification_policy_ref`, `classification_evidence_url`. One `PATCH` per entity with `create_missing_related_entities=false`; the legacy `service` relation is never in a body (`validate_request` rejects anything else).

- `classification_policy_ref`: last commit on the trusted tip touching `graph.yaml` or `pgraph/`, checked to equal the tip's blob and tree.
- `classification_evidence_url`: `https://github.com/Kemetra-Labs/Retail-Tower-Erp/compare/<diff_base>...<head>`, which shows exactly the classified diff and records the classified head.
- Deterministic `insufficient_evidence`: status + `affected_services = []` (clears an older list).
- No verdict and the stored head is still the current head: write nothing. Head moved: `attribution_status=pending`, `attribution_scope=unknown`, list cleared.
- A merged PR already `classified` for its final head is frozen.
- A needed service missing in Port, or no matching/ambiguous Port entity: skip, never create.
- `is_stale(item, live_head)` is the check the writer must run immediately before and after a write.

## Not here

No Port or GitHub calls, workflow, credentials, schema change or Ocean mapping change. The credential, the write probe and the workflow are separate, gated slices.
