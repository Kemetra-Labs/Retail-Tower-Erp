# tools/contracts-check

`contracts/check` (RT-868, decision [MR-2](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/55771138)): every consumer is checked against the in-tree Backend-Core contract `services/backend-core/packages/contracts/openapi` at the same commit, so a change that breaks POS, Admin-Console or the Connector fails in the PR that makes it. Run by `.github/workflows/contracts.yml`.

## Checks

| Check | Compares | Fails on | Reported, not failing |
| --- | --- | --- | --- |
| `pins` | each `file: <path> <blob>` of `apps/pos/contracts/backend-core/PIN`, `apps/admin-console/contracts/backend-core/PIN` and `integrations/erpnext-connector/contracts/backend-core/PIN` (RT-704), read from this repository's object store, against the in-tree file (`oasdiff breaking`, Backend-Core severity levels) | WARN or ERR finding; a PIN whose `repo:` is not this repository (`repository` in `config.yaml`) or whose `source:` is not `contracts_root` (RT-889); a `commit:` that is not in this repository's object store, or a `file:` blob that is not the blob of that path at the PIN's `commit:` (a partial or mixed pin, RT-1407); missing blob; vendored POS copy not hashing to its pin; pinned file gone from the tree; malformed PIN; any oasdiff error or unparseable output | every other change (`oasdiff changelog`); a stale pin, whose blob differs from the in-tree file even when oasdiff sees no API change (RT-1407) |
| `connector` | `connector/posting/contracts.py`, `connector/bin_view/contracts.py` and `connector/stock_import/contracts.py` (parsed with `ast`, never imported) against `posting-feed.yaml`, `stock-view.yaml` and `stock-import.yaml` | enum set ≠ schema `enum`/`const`; pattern ≠ schema `pattern` (`\d` = `[0-9]` only under `re.ASCII`; `\w`/`\s`/`\b` without `re.ASCII` fail); a read whose key cannot be resolved; a field read or emitted that the schema lacks; a field read by bare subscript that the schema does not require; a required field `to_wire` never emits; a class with `from_wire`/`to_wire` and no same-named schema; an unclassified module-level frozenset or `re.compile` | docstring version ≠ `info.version`; an equal pattern ending in Python `$`, which also accepts a trailing newline that the contract rejects |
| `identical` | each group under `identical:` in `config.yaml`: the four `obs1-golden-vectors.json` copies and the four `rt879-redaction-vectors.json` copies (RT-879), and the two `golden-vectors.json` copies of the Offer Engine (RT-1339: Backend-Core and POS) | any byte difference or missing copy | — |

Everything that cannot be compared fails (fail closed). The mapping of Connector constants to schema locations is in `config.yaml`; a new constant must be mapped or listed as `local` with a reason.

The Connector PIN (RT-704) pins the five files the Connector calls: `erpnext-connector/posting-feed.yaml`, `stock-view.yaml`, `connector-health.yaml` (heartbeat), `stock-import.yaml` (RT-1287) and `provisioning-feed.yaml` (the tenant provisioner, RT-1359). `tests/test_pins.py` (`ConnectorPin`) fails when a `contract:` under `connector:` is not pinned, or when a `get`/`post` in the Connector transports targets a method and path that no pinned file serves.

### Repinning (one commit per PIN, RT-1407)

Every consumer PIN describes one commit: each `file:` blob must be the blob of that path at `commit:`, and `pins` fails otherwise, so a single hand-edited line cannot pass. Rewrite a PIN only with its consumer's command (also `repin` in `config.yaml`), which reads every file at one commit from local git (no network):

| Consumer | Command |
| --- | --- |
| POS | `npm run contracts:repin -- --ref <ref>` in `apps/pos` (also refreshes the vendored copies and `api-types.ts`) |
| Admin-Console | `pnpm generate:client --repin <ref>` in `apps/admin-console` (also regenerates the client) |
| ERPNext-Connector | `python integrations/erpnext-connector/scripts/contracts_repin.py [--ref <ref>] [--add <path>] [--remove <path>]` from the repository root (default ref `main`; the Connector vendors no copies) |

Pin a commit that is on `main`: CI reads it from git, and a squash merge drops branch-only commits. Consumers lag `main` on purpose until they repin, so a pinned blob behind the in-tree file is a `stale pin` drift line in the job summary, not a failure.

## Commands

```bash
cd tools/contracts-check
python -m pip install --require-hashes --only-binary=:all: --no-deps -r ../project-graph/requirements.txt
CONTRACTS_CHECK_OASDIFF=/path/to/oasdiff python -m unittest discover -s tests -v
python -m contracts_check --repo ../.. --oasdiff /path/to/oasdiff [--summary summary.md] [--only pins|connector|identical]
```

For a system release (RT-1030), `--backend-rev <rev>` reads the contract at that commit instead of the working tree, and each `--consumer-rev <name>=<rev>` reads that consumer's PIN (and vendored copies) at its commit. With any `--consumer-rev`, the pins check runs only the named consumers. `.github/release/system_gate.py --contracts-args` prints these arguments for a manifest in `system/releases/`.

`oasdiff` is the bc/oasdiff pin (1.32.1, sha256-verified). Without `CONTRACTS_CHECK_OASDIFF` the real-oasdiff tests are skipped locally; CI always sets it. The check needs full history (`fetch-depth: 0`) because pinned blobs come from older commits.

## Known gaps (named, not silently relaxed)

1. **Connector types are not compared.** Only names, enums, patterns and required-ness: a field that changes from string to object passes this check.
2. **Inline literals are not compared**, such as `RefundTender` accepting only `"cash"` or `ErpnextItemRef.doctype == "Item"`; only module-level constants are.
3. **Required-ness is read from bare subscripts.** A field read with `.get` and then rejected when absent counts as optional (under-claims, never over-claims).
4. **`consumers.txt` and the POS `generated` rule** (RT-868 scope items 2 and 3) are in `services/` and `apps/`, outside this Shadow-native slice (MR-7).
5. **No acknowledgement mechanism.** Unlike bc/oasdiff there is no ignore file; an accepted break needs a repin of the consumer, or an owner-approved allowlist added later.
