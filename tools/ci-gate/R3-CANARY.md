# R3 canary runbook (RT-721 Substep B, step B4)

Proves the trust plumbing of the T-A gate on an **isolated** ruleset, so `main` is never blocked. Each GitHub write below needs the owner's authorization. Independent witnessing and the negative probes belong to RT-711.

## Pieces

- `.github/workflows/r3-canary.yml`: manual only (`workflow_dispatch`).
  - `source=app` mints a `kemetra-ci-gate` token inside the `ci-gate` environment and posts `required`.
  - `source=token` posts `required` with `GITHUB_TOKEN`, as a spoof attempt.
- `r3-canary-ruleset.json`: requires `required` on `refs/heads/canary/**` only, with the source pinned to `integration_id` 5373080 and no bypass actors.

## Writes (owner-authorized)

| # | Write |
| --- | --- |
| W1 | Fast-forward `main` with this commit, so the workflow can be dispatched from `main` |
| W2 | Create branch `canary/r3` at `main`. Create branch `r3-canary-head` (outside `canary/**`) with one empty commit `H`. Open PR `r3-canary-head` → `canary/r3` |
| W3 | Create the ruleset: `gh api -X POST repos/Kemetra/Retail-Tower-Shadow/rulesets --input tools/ci-gate/r3-canary-ruleset.json` |
| W4 | Dispatch the canary runs below (each posts one check-run on `H`) |

## Checks and expected results

| # | Action | Expected |
| --- | --- | --- |
| C0 | Read the ruleset back; `GET rules/branches/canary/r3`; read the PR merge state | rule present with `integration_id: 5373080`; PR **BLOCKED** |
| C1 | Dispatch on `main` with `source=token`, `head_sha=H` | check-run `required` from app `github-actions`; PR **still BLOCKED** |
| C2 | Dispatch on ref `r3-canary-head` with `source=app` | the job is **refused by the `ci-gate` environment** (branch not allowed); no App token is minted; no new check-run |
| C3 | Dispatch on `main` with `source=app`, `head_sha=H` | check-run `required` from App **5373080**; PR **no longer blocked** by the ruleset. The PR is **not** merged |

**STOP (B5) if:**
- C3 does not unblock the PR (the source pin is unsupported, or `checks:write` is not accepted);
- C1 unblocks it (the spoof succeeds);
- C2 mints a token (the environment branch policy is not enforced).

Do not widen App grants and do not move the key to repository secrets.

## Cleanup (after RT-711 has witnessed)

- Delete the ruleset.
- Close the PR.
- Delete both branches.
- Remove `r3-canary.yml` from `main`.
