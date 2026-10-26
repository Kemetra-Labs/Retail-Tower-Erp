# Architecture

Retail Tower is one platform in one repository: one CI, one contract source and one set of engineering rules. The four products stay independently versioned and released. The owner-approved rules are MR-1…MR-9 on Confluence: [Monorepo target architecture — MR-1…MR-9](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/55771138). This file summarises them and says what is in place on `main`; Confluence wins on any conflict about intent, and `main` is the technical truth.

## Products

| Product | Path | Role | Toolchain |
| --- | --- | --- | --- |
| POS | `apps/pos/` | Windows cashier terminal, offline-capable | Electron, npm |
| Admin-Console | `apps/admin-console/` | Admin and operator web UI | Vite, pnpm |
| Backend-Core | `services/backend-core/` | API, worker, database; contract and orchestration boundary | Node, pnpm workspace |
| ERPNext-Connector | `integrations/erpnext-connector/` | The only ERPNext/Frappe adapter | Python, uv |

Integration path: `POS / Admin-Console -> Backend-Core -> ERPNext-Connector -> ERPNext / Frappe`. POS and Admin-Console never call ERPNext or Frappe directly.

## Allowed edges

`tools/project-graph/graph.yaml` `edges` is the full list. Any other cross-product reference fails `boundary-check`.

| From | To | Only through |
| --- | --- | --- |
| pos | backend-core | `services/backend-core/packages/contracts/openapi/**` |
| admin-console | backend-core | `services/backend-core/packages/contracts/openapi/**` |
| erpnext-connector | backend-core | `.../openapi/erpnext-connector/**`, `.../openapi/connector/**` (`kind: semantic`: the Connector mirrors these DTOs in Python) |

Layer 1 (`pgraph boundary`, every PR) also rejects ERPNext/Frappe REST routes (`/api/resource/...`, `/api/method/...`) in `apps/**` (`erp-egress`, MR-6). Exceptions live only in `tools/project-graph/boundary-todo.yaml`, one entry per Jira key, and the list may only shrink; a stale entry fails the check. Today it has one entry (Admin-Console codegen fallback path, RT-715). Layer 2 (per-product rules) is not implemented yet (RT-873).

## Contract source (MR-2)

`services/backend-core/packages/contracts/openapi` is the only contract source. The consumers still read pinned copies: POS and Admin-Console through `contracts/backend-core/PIN` (POS also vendors the pinned files), and the Connector through its own Python DTOs.

`contracts/check` (`.github/workflows/contracts.yml`, `tools/contracts-check/`, RT-868) compares every consumer with the in-tree contract at the same commit, so a break fails in the PR that makes it:

- **pins**: each file in the POS and Admin-Console `PIN`, read by blob SHA from this repository, against the in-tree file with `oasdiff breaking`. A WARN or ERR finding fails; other changes are listed as drift in the job summary.
- **connector**: `posting/contracts.py` and `bin_view/contracts.py`, parsed with `ast`, against `posting-feed.yaml` and `stock-view.yaml`: enums, patterns, field names and required fields. A version-string mismatch is reported, not failed.
- **identical**: the four OBS-1 `obs1-golden-vectors.json` copies and the four RT-879 `rt879-redaction-vectors.json` copies must each be byte-identical (MR-6c).

Anything it cannot compare fails. It does not compare Connector field types or inline literals, and has no acknowledgement file (see its README). The graph selects it from the Backend-Core `contracts` tier and from each consumer's `contracts` tier; that Backend-Core tier also selects `pos/static`, `pos/test`, `admin/build-test`, `connector/unit-tests-and-lint` and `bc/oasdiff`.

Still to come: POS generates its types from its pinned contract (RT-869). At cutover (RT-715) POS and Admin-Console generate from the in-tree path, and the pins and repin bots are retired.

## Gate

- **Selection (MR-4).** The graph selects which jobs run and which results count. Each product workflow's `plan` job runs the base-branch evaluator; graph jobs run only if selected; a selected job that is skipped fails `required`; a push to `main` runs everything. Semantic edges: Backend-Core `sales`, `money` and `posting-sync` also select `pos/static` and `pos/test`; Connector `posting-sync` also selects `bc/fast`. See [README.md](README.md#how-ci-selects-jobs).
- **`required`.** `.github/workflows/gate.yml` runs only base-branch code and posts `required` with its own `GITHUB_TOKEN`, scoped to `checks: write` (owner decision 2026-10-25: no `kemetra-ci-gate` App). `required` therefore comes from the same producer as every other check (GitHub Actions); that `.github/**` is policy class is what keeps another workflow from posting it. A change to a `policy` path (below) needs an APPROVED, SHA-bound review by a login in `policy_approvers` (today `[Kemetra]`).
- **Policy class.** `.github/**`, `apps/*/.github/**`, `services/*/.github/**`, `integrations/*/.github/**`, `tools/project-graph/**`, `tools/ci-gate/**`, `tools/agent-broker/**` and `CODEOWNERS`. Policy outranks product ownership, so a product's own `.github/**` is policy too.
- **Not yet in place.** The delegated reviewer identity as approver by numeric ID (MR-5, RT-870); `required` as a required check in the `main` ruleset with no bypass (RT-866); independent verification of the gate (RT-711).

## Release model (MR-1, MR-3)

Each product keeps its own version and release tag: `pos/vX.Y.Z`, `admin-console/vX.Y.Z`, `backend-core/vX.Y.Z`, `erpnext-connector/vX.Y.Z`. There is no lockstep version and no shared runtime package across products. Each product has a root release workflow (`.github/workflows/release-<product>.yml`, RT-871), started only by its own tag or by a manual dispatch that defaults to a dry-run. Every run builds the product's artifact and writes a release manifest (`.github/release/manifest.py`): source SHA, product tree hash, artifact digests, contract snapshot and CI URL. Publish jobs sit behind one environment per product (`release-<product>`) and refuse on Shadow: nothing is published until RT-717. The Connector is distributed through an append-only mirror whose root is `integrations/erpnext-connector/` (`tools/release/connector-mirror/`, RT-712).

A Backend-Core release and lab deploy require `contracts-compat` for the release SHA (MR-3, RT-863). Until recorded replay fixtures exist (RT-714), the PR-mode result and the stale-fleet check must pass and the release evidence records `NOT_PROVEN`. The root release guard is `.github/release/compat-gate.cjs`, ported from the product's RT-863 gate; it requires a green `bc/contracts-compat` run on the release SHA. That is the root graph job in `backend-core.yml` (RT-863), part of `@bc-full`, so it runs for every Backend-Core change and on every push to `main`.

## MR-1…MR-9 in one line each

| ID | Rule |
| --- | --- |
| MR-1 | One repo, one CI, one contract source; each product keeps its own toolchain, lockfile, version and release tag. |
| MR-2 | The Backend-Core OpenAPI tree is the only contract source; a break of any consumer fails in the PR that makes it. |
| MR-3 | Compatibility with installed POS (`contracts-compat`) gates Backend-Core release and lab deploy. |
| MR-4 | CI runs only what `graph.yaml` selects; the same selection decides the `required` verdict. |
| MR-5 | Policy approval is delegated to a Claude reviewer under its own identity, listed by numeric ID; the owner keeps admin break-glass. |
| MR-6 | Boundaries enforced at two layers; exceptions only as a shrinking, ticketed ratchet; one copy of each shared policy artifact; one declared runtime version per product; no shared lint/tsconfig package. |
| MR-7 | Since the RT-715 cutover (2026-10-25), all code, product and repo-wide, lands in this repository by PR to `main`; the former source repos and Shadow are frozen read-only and kept for history. Before the cutover, product code landed in the source repos and reached Shadow by import. |
| MR-8 | One verified incremental re-import before the RT-711 parity runs; otherwise imports are paused until the RT-715 freeze. |
| MR-9 | RT-715 cutover starts only when RT-868, RT-869, RT-867, RT-870, RT-863, RT-866 and RT-871 are done and verified on Shadow. |
