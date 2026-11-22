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

Inside Backend-Core, every database table is owned by one module, declared in `services/backend-core/tools/module-boundaries/module-map.json`, and `lint:module-boundaries` checks both `apps/api/src` and `apps/worker/src` against it (RT-1453, RT-1525). Adding a table: give it an owner there in the same PR as its migration, or the check fails.

## Allowed edges

`tools/project-graph/graph.yaml` `edges` is the full list. Any other cross-product reference fails `boundary-check`.

| From | To | Only through |
| --- | --- | --- |
| pos | backend-core | `services/backend-core/packages/contracts/openapi/**`, and the one Offer Engine exception below (`.../packages/offer-engine/**`, `.../packages/contracts/fixtures/offers/**`) |
| admin-console | backend-core | `services/backend-core/packages/contracts/openapi/**` |
| erpnext-connector | backend-core | `.../openapi/erpnext-connector/**`, `.../openapi/connector/**` (`kind: semantic`: the Connector mirrors these DTOs in Python) |

Layer 1 (`pgraph boundary`, every PR) also rejects ERPNext/Frappe REST routes (`/api/resource/...`, `/api/method/...`) in `apps/**` (`erp-egress`, MR-6). Exceptions live only in `tools/project-graph/boundary-todo.yaml`, one entry per Jira key, and the list may only shrink; a stale entry fails the check. Today it is empty: RT-889 removed the last entry (the Admin-Console codegen fallback to a sibling Backend-Core checkout). Layer 2 (per-product rules) is not implemented yet (RT-873).

## Contract source (MR-2)

`services/backend-core/packages/contracts/openapi` is the only contract source. Each consumer pins the files it uses at one commit of this repository, in its own `contracts/backend-core/PIN`:

- **POS** (`apps/pos/contracts/backend-core/PIN`): also vendors the pinned files under `contracts/backend-core/openapi/` and generates `src/shared/api-types.ts` from them (RT-869). Repin with `npm run contracts:repin -- --ref <ref>` in `apps/pos`.
- **Admin-Console** (`apps/admin-console/contracts/backend-core/PIN`): generates `src/generated/schema.d.ts` from the in-tree contract read from git at the pinned commit (RT-677, RT-889). Repin with `pnpm generate:client --repin <ref>` in `apps/admin-console`.
- **ERPNext-Connector** (`integrations/erpnext-connector/contracts/backend-core/PIN`, RT-704): pins the feeds it calls and mirrors their DTOs in Python; it vendors no copies. Repin with `python integrations/erpnext-connector/scripts/contracts_repin.py [--ref <ref>]` from the repository root (RT-1407).

A PIN describes one commit: every `file:` blob must be the blob of that path at `commit:` (RT-1407), so rewrite a PIN only with its consumer's repin command. Consumers lag `main` until they repin; no bot repins them. The `generated:` rule in `tools/project-graph/graph.yaml` lets a generated client change only together with one of its declared sources (the PIN, the vendored or in-tree contract, the generator script or config, or the lockfile).

`contracts/check` (`.github/workflows/contracts.yml`, `tools/contracts-check/`, RT-868) compares every consumer with the in-tree contract at the same commit, so a break fails in the PR that makes it:

- **pins**: each file in the POS, Admin-Console and Connector `PIN`, read by blob SHA from this repository, against the in-tree file with `oasdiff breaking`. A WARN or ERR finding fails, and so does a PIN that does not describe one commit; other changes, including a stale pin, are listed as drift in the job summary.
- **connector**: the Connector modules listed under `connector:` in `tools/contracts-check/config.yaml` (the `posting`, `bin_view` and `stock_import` `contracts.py` and the provisioner `feed_client.py`), parsed with `ast`, against `posting-feed.yaml`, `stock-view.yaml`, `stock-import.yaml` and `provisioning-feed.yaml`: enums, patterns, field names and required fields. A version-string mismatch is reported, not failed.
- **identical**: each group under `identical:` in `tools/contracts-check/config.yaml` must be byte-identical (MR-6c), for example the four OBS-1 `obs1-golden-vectors.json` copies and the four RT-879 `rt879-redaction-vectors.json` copies.

The [contracts-check README](tools/contracts-check/README.md) is the full list of what each check compares and fails on.

Anything it cannot compare fails. It does not compare Connector field types or inline literals, and has no acknowledgement file (see its README). The graph selects it from the Backend-Core `contracts` tier and from each consumer's `contracts` tier; that Backend-Core tier also selects the `@bc-full` group, `pos/static`, `pos/test`, `admin/build-test`, `admin/e2e`, `connector/unit-tests-and-lint` and `contracts/check` (see `graph.yaml`).

## Gate

- **Selection (MR-4).** The graph selects which jobs run and which results count. Each product workflow's `plan` job runs the base-branch evaluator; graph jobs run only if selected; a selected job that is skipped fails `required`; a push to `main` runs everything. Semantic edges: Backend-Core `sales`, `money` and `posting-sync` also select `pos/static` and `pos/test`; Connector `posting-sync` also selects `bc/fast`. See [README.md](README.md#how-a-pull-request-is-proved).
- **`required`.** `.github/workflows/gate.yml` runs only base-branch code and posts `required` with its own `GITHUB_TOKEN`, scoped to `checks: write` (owner decision 2026-10-25: no `kemetra-ci-gate` App). `required` therefore comes from the same producer as every other check (GitHub Actions); that `.github/**` is policy class is what keeps another workflow from posting it. A change to a `policy` path (below) needs an APPROVED, SHA-bound review by an account in `policy_approvers`, matched by numeric id and type (today the owner `Kemetra` and the reviewer App `kemetra-reviewer[bot]`). While `graph.yaml` has `policy_approval: observe` (owner decision 2026-10-27, RT-578; the owner is the only maintainer) the approval is still evaluated and printed, but a missing one does not fail `required`.
- **Policy class.** `tools/project-graph/graph.yaml` `shared_classes` is the authoritative list; every class there with `policy_change: true` is a policy change. Today that is the `policy` class (`.github/**`, `apps/*/.github/**`, `services/*/.github/**`, `integrations/*/.github/**`, `tools/project-graph/**`, `tools/ci-gate/**`, `tools/agent-broker/**`, `CODEOWNERS`, `.gitleaks.toml`, `.gitleaksignore`, `.python-version`, `renovate.json5`), which selects every job, plus three classes that select only `contracts/check`: `circleci` (`.circleci/**`), `release_tooling` (`.github/release/**`) and `depot` (`.depot/**`). Policy outranks product ownership, so a product's own `.github/**` is policy too.
- **Lockfiles.** `CODEOWNERS` deliberately leaves the four product lockfiles (`apps/pos/package-lock.json`, `apps/admin-console/pnpm-lock.yaml`, `services/backend-core/pnpm-lock.yaml`, `integrations/erpnext-connector/pylock.toml`) without an owner (the Bitwarden pattern), so that once code-owner review is required (today `CODEOWNERS` is advisory) Renovate's dependency PRs do not wait on one: `renovate.json5` lets Renovate rewrite the npm and pnpm lockfiles, while the Python lock is hash-pinned by hand. This is not a security exemption: a lockfile change still goes through PR review and the `dependency-review` job, which runs on every PR.
- **Not yet in place.** An end-to-end demonstration that the reviewer App's approval clears `required` on an agent-authored policy PR (RT-870; the App is listed in `policy_approvers`); separating agent sessions from the `Kemetra` credentials (R1); `required` as a required check in the `main` ruleset with no bypass (RT-866); independent verification of the gate (RT-711).

## Release model (MR-1, MR-3)

Each product keeps its own version and release tag: `pos/vX.Y.Z`, `admin-console/vX.Y.Z`, `backend-core/vX.Y.Z`, `erpnext-connector/vX.Y.Z`. POS also has a separate pilot tag, `pos-pilot/vX.Y.Z` (`release-pos-pilot.yml`, RT-1294), so a pilot installer and a lab installer never share a release. There is no lockstep version and no shared runtime package across products, with one narrow exception (RT-1378, owner decision 2026-11-13): the pure Offer Engine money evaluator, `services/backend-core/packages/offer-engine`, which Backend-Core and the POS till both import so a discount rule is changed in one place (it replaced two copies). It stays inside the Backend-Core workspace and Docker build context; the POS builds it from source (`npm run build:offer-engine`, run by `pretest`, `pretypecheck`, `prelint` and `prebuild:main`) and links it with an npm `file:` dependency, so the POS stays on npm. The package must stay pure (no I/O, clock, database or UI); it is not a general shared library, and no other product path may be added to the graph edge. Each product has a root release workflow (`.github/workflows/release-<product>.yml`, RT-871), started only by its own tag or by a manual dispatch that defaults to a dry-run. Every run builds the product's artifact and writes a release manifest (`.github/release/manifest.py`): source SHA, product tree hash, artifact digests, contract snapshot and CI URL. Publish jobs sit behind per-product environments (`release-<product>`; POS also has a signing environment, `release-pos-sign`, and the pilot lane its own `release-pos-pilot` and `release-pos-pilot-sign`) that admit only that product's tags.

What publishes today (RT-717 is still open):

- **Backend-Core** and **Admin-Console**: a tag creates a GitHub release (RT-717 B1, C1).
- **POS**: a `pos/v*` tag creates a lab-signed installer release (RT-1082), and a `pos-pilot/v*` tag a pilot-signed one (RT-1294).
- **ERPNext-Connector**: the `publish` job of `release-erpnext-connector.yml` still refuses, so there is no Connector GitHub release yet. The Connector is distributed through an append-only mirror, `Kemetra-Labs/ERPNext-Connector`, whose root is `integrations/erpnext-connector/` (`tools/release/connector-mirror/`, RT-712). `mirror-erpnext-connector.yml` appends one commit to it for every `main` commit that changes the Connector, and pushes only when the owner has set `MIRROR_PUBLISH_ENABLED` and the `connector-mirror` environment admits the run.

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
