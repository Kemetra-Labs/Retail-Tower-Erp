# Port writer executor — Phase 4, slice S2 (offline, dry-run first)

`pgraph.port_writer` decides whether the one write that `pgraph.port_sync` plans is safe to send **now**, sends it only on explicit approval, and checks the result. GitHub and Port are reached only through injected transport objects. The module has no HTTP client, holds no credentials, reads no process settings and never imports PR code. The classifier (`port_attribution`) and planner (`port_sync`) are reused unchanged: the writer-owned fields, the allow-list of services and `validate_request` all come from the planner.

```bash
cd tools/project-graph
python -m pgraph.port_writer dry-run --repo ../.. --main-sha "$TRUSTED_MAIN_FULL_SHA" --pr 558 \
  --prs prs.json --entities entities.json --services services.json --out report.json
```

The only CLI command is this offline `dry-run` over recorded snapshots (same files as `port_sync plan`). Its transports are read-only and its `patch_entity` raises, so the CLI cannot write. Applying is a library call, `run(..., apply=True, expected_digest=...)`, for a later transport slice.

## Transports (duck-typed)

| Call | Returns |
|---|---|
| `github.main_sha()` | the trusted protected-branch tip right now |
| `github.get_pr(number)` | the PR snapshot `port_sync` documents, or `None` |
| `port.find_entities(number)` | every Port pull-request entity with that PR number, of any repository. Each read resolves the one entity of this repository with the planner's own `find_entity`, so another repository's entity with the same number is ignored, while a second entity of this repository is ambiguous |
| `port.service_ids()` | identifiers of the Port service entities |
| `port.patch_entity(request)` | sends exactly the validated partial update, the only write |

## Order of a run (one PR, at most one write)

1. **Inputs.** `apply` must be exactly `True` or `False`; the PR number, the 40-hex tip and the write cap are validated. Bad input is `refused` with no transport call.
2. **Apply guards, before any read.** `apply` needs a 64-hex digest and a write cap of at least 1.
3. **Snapshot.** The live tip must equal the supplied trusted tip (`STALE_MAIN_TIP`), the PR snapshot must be for this PR, and all reads must succeed.
4. **Plan** with the unchanged planner. A planner `skip` is `blocked` with its reason; `noop` is `noop`. The planned request goes through `validate_request`; a request carrying anything but the writer-owned fields (for example the legacy `service` relation) is `refused`.
5. **Dry run (default)** stops here: the report carries the exact request, the digest, the stored values before and a prepared rollback request.
6. **Digest.** SHA-256 over the entity, the planned head, the exact request and the stored writer values before. It must equal the approved digest, so an approval cannot authorize another head, another request or another starting state.
7. **Pre-write recheck.** Port has no conditional write (none is documented in its PATCH reference), so everything is read again immediately before the write: tip, PR state and head, the one entity (every property and relation, not only the writer fields), and the services. Any difference is `blocked`, with all reasons listed.
8. **One PATCH**, validated once more on the exact object sent. A failure is `error`: the exception class is recorded, its text is not (it may contain secrets), and nothing is retried.
9. **Read-back.** The writer fields equal the desired state; every other property and relation equals the pre-write snapshot; re-planning gives `noop`; the live head is unchanged; the entity is still unique. Otherwise `verify_failed`.

## Results

| Result | Meaning | Writes |
|---|---|---|
| `dry_run` | would send the reported request | 0 |
| `noop` | already correct, or a merged PR frozen for its final head | 0 |
| `blocked` | stale, missing or ambiguous evidence, or a planner skip | 0 |
| `refused` | bad input, missing or wrong digest, write cap, or a forbidden request | 0 |
| `written` | sent and verified | 1 |
| `verify_failed` | sent, but the read-back disagrees | 1 |
| `error` | the write call itself failed | 1 |

`verify_failed` and `error` include a **rollback request** that restores the previous writer values. It is only reported. Sending it is a separate write that needs its own approval. If the previous values cannot be expressed by the writer (for example Port's `failed` status), the request is `None` and the note is `BEFORE_STATE_NOT_REPRESENTABLE`.

## Limits worth knowing

- A change to **any** field that the recheck observes between the first read and the recheck blocks the run. That is deliberate and can cost a retry.
- The recheck narrows the race window; it cannot close it, because Port offers no compare-and-swap. A change made after the recheck read and before the PATCH is not blocked: the write still goes out, and the read-back reports it as `verify_failed` only if it altered a field the executor compares. So a stale write is detected after the fact, not prevented, and the rollback request is the remedy.
- A change made by another system after the PATCH but before the read-back is likewise reported as `verify_failed`.
- The baselines are deep copies taken at the first read, so a transport that returns its own cached objects cannot move them.
- The report contains the stored values of the writer-owned fields and the full request. It holds no credentials; the transports own those.

## Not here

No HTTP client, workflow, credential, Port service account or permission change, resync, backfill or live write. Which identity may write, the real transport and the workflow are separate, gated slices. `port_sync.py`, `port_attribution.py`, the CI gate, `graph.yaml`, the Ocean mapping and the Port schema are unchanged.
