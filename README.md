# Retail Tower monorepo

`Kemetra-Labs/Retail-Tower-Erp` holds the four Retail Tower products in one repository, with one CI and one project graph. It is the canonical repository since the RT-715 cutover (2026-10-25): all code lands here by PR to `main`. Before the cutover, product code was imported from the four source repositories, which are now frozen read-only and kept for history (see [CLAUDE.md](CLAUDE.md), landing rule).

Architecture and the monorepo rules (MR-1…MR-9): [ARCHITECTURE.md](ARCHITECTURE.md).

## What lives where

| Path | What | Imported from until the cutover |
| --- | --- | --- |
| `apps/pos/` | POS: Windows cashier terminal (Electron, npm) | `Kemetra/POS` |
| `apps/admin-console/` | Admin-Console: admin and operator web UI (Vite, pnpm) | `Kemetra/Admin-Console` |
| `services/backend-core/` | Backend-Core: API, worker, database, OpenAPI contracts (pnpm workspace) | `Kemetra/Backend-Core` |
| `integrations/erpnext-connector/` | ERPNext-Connector: the only ERPNext/Frappe adapter (Python, uv) | `Kemetra/ERPNext-Connector` |
| `tests/e2e/` | Cross-product wire smoke against a real Backend-Core stack (`e2e/smoke`) | Shadow-native |
| `tools/contracts-check/` | `contracts/check`: consumers against the in-tree Backend-Core contract (MR-2, [README](tools/contracts-check/README.md)) | Shadow-native |
| `tools/project-graph/` | `graph.yaml` and `pgraph`: job selection, `required` verdict, boundary check ([README](tools/project-graph/README.md)) | Shadow-native |
| `tools/ci-gate/` | Gate runbooks: R3 canary, agent token broker design | Shadow-native |
| `tools/agent-broker/` | `kemetra-agent` token broker, run on the owner's machine | Shadow-native |
| `tools/history/` | Import metadata: `frozen.tsv` (imported source SHA per product), crosswalks, refs | Shadow-native |
| `tools/release/connector-mirror/` | Append-only publisher of the Connector subtree to its distribution mirror (RT-712) | Shadow-native |
| `.github/workflows/` | Root CI: one workflow per product, `contracts`, `e2e`, `project-graph`, the selftest and the gate | Shadow-native |

Each product directory keeps its own `README.md`, `CLAUDE.md`, toolchain and lockfile. The product's own `.github/workflows/` are imported with it but do not run here; only root workflows run.

## How CI selects jobs

`tools/project-graph/graph.yaml` is the only selector (MR-4). For a pull request:

1. **Graph.** Every changed path is classified: a shared class (`policy`, `tooling`, `e2e`, `docs`, `root`) or a product risk tier (`contracts`, `money`, `sales`, ...). Each class or tier names the jobs it needs. Paths a product does not classify count as `high`, which selects the product's full suite. Fail closed: when in doubt, more jobs run.
2. **Plan job.** Each root product workflow (`pos`, `admin-console`, `backend-core`, `erpnext-connector`, `contracts`, `e2e`) starts with a `plan` job. It takes `tools/project-graph` from the trusted commit (the PR base) with `git archive`, runs `python -m pgraph evaluate` on the base and head SHAs, and outputs the selected job keys. PR code is read as data, never run.
3. **Guarded jobs.** Every graph job needs `plan` and runs only if its key is in the plan output. `boundary-check` and `dependency-review` (in `project-graph.yml`) always run. A push to `main` selects everything.
4. **`required`.** `.github/workflows/gate.yml` re-evaluates the PR from the base branch, collects the results of the selected jobs from the GitHub Actions app, and posts one check-run named `required`. A selected job that fails, is cancelled or is skipped fails it (`JOB_FAILED`, `JOB_CANCELLED`, `UNEXPECTED_SKIP`). A change to a `policy` path also needs an APPROVED review on the head commit by a login in `policy_approvers`, containing the exact `policy-change-approved:` line the gate prints; until then `required` reports `POLICY_APPROVAL_REQUIRED`.

Making `required` a required check on `main` (S6 no-bypass ruleset) is RT-866, still open. Details: [tools/project-graph/README.md](tools/project-graph/README.md).

Other root workflows, outside the graph: `project-graph-selftest.yml` (pgraph tests, `classify-tree`, `privileges`, `boundary` and the `.github/release/` specs on every PR), `pos-asar-parity.yml` and `r3-canary.yml` (manual only), and the four `release-<product>.yml` workflows (RT-871: product tag or manual dry-run only; see [ARCHITECTURE.md](ARCHITECTURE.md#release-model-mr-1-mr-3)).

## Running each product

Commands are the ones the root workflows run. Run them from the product directory. Development servers and environment setup are in each product's README.

**POS** (`apps/pos/`, npm; CI uses Node 24)

```bash
npm ci
npm run lint && npm run typecheck
npm test
npm run dev          # Vite + Electron
npm run package:dir  # Windows unpacked build (pos/package-windows runs on windows-latest)
```

**Admin-Console** (`apps/admin-console/`, pnpm; CI uses Node 22)

```bash
pnpm install --frozen-lockfile
DATA_PULSE_2_REPO=<Backend-Core checkout> pnpm generate:client   # CI fetches the pinned commit with .github/scripts/fetch-pinned-contracts.sh
pnpm lint && pnpm test && pnpm build
pnpm test:e2e          # Playwright
pnpm dev
```

**Backend-Core** (`services/backend-core/`, pnpm workspace; CI uses Node 22, Postgres 16 for DB suites)

```bash
pnpm install --frozen-lockfile
pnpm -r run build
pnpm lint && pnpm typecheck
pnpm --filter @data-pulse-2/api test      # bc/db-integration (needs Postgres)
pnpm --filter @data-pulse-2/db test       # bc/db-package (needs Postgres)
pnpm dev
```

The development stack (Postgres, Redis) is described in `services/backend-core/README.md`.

**ERPNext-Connector** (`integrations/erpnext-connector/`, uv; CI uses Python 3.11)

```bash
uv pip install --require-hashes --no-build -r pylock.toml
python -m ruff check retail_tower_erpnext_connector
python -m pytest -q retail_tower_erpnext_connector/tests
```

**e2e smoke** (repository root; needs Docker)

```bash
export FUZZ_OUT="$PWD/.e2e-smoke"
bash services/backend-core/tools/schemathesis/stack-up.sh   # throwaway stack; writes the operator envelope under $FUZZ_OUT
E2E_BASE_URL=http://127.0.0.1:23100 E2E_ENVELOPE_FILE="$FUZZ_OUT/envelope-operator" node --test tests/e2e/*.test.mjs
```

**Consumer contracts** (`tools/contracts-check/`, Python 3.12; needs full git history and the `oasdiff` 1.32.1 binary that `bc/oasdiff` pins)

```bash
python -m pip install --require-hashes --only-binary=:all: --no-deps -r ../project-graph/requirements.txt
CONTRACTS_CHECK_OASDIFF=/path/to/oasdiff python -m unittest discover -s tests -v
python -m contracts_check --repo ../.. --oasdiff /path/to/oasdiff
```

**Project graph** (`tools/project-graph/`, Python 3.12)

```bash
python -m pip install --require-hashes --no-deps -r requirements.txt
python -m unittest discover -s tests -v
python -m pgraph classify-tree --repo ../.. --rev HEAD
python -m pgraph boundary --repo ../.. --rev HEAD
python -m pgraph privileges --repo ../..
```

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
