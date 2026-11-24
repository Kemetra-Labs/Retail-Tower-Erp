# tools/contracts-check

`contracts/check` (RT-868, decision [MR-2](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/55771138)): every consumer is checked against the in-tree Backend-Core contract `services/backend-core/packages/contracts/openapi` at the same commit, so a change that breaks POS, Admin-Console or the Connector fails in the PR that makes it. Run by `.github/workflows/contracts.yml`.

## Checks

| Check | Compares | Fails on | Reported, not failing |
| --- | --- | --- | --- |
| `pins` | each `file: <path> <blob>` of `apps/pos/contracts/backend-core/PIN`, `apps/admin-console/contracts/backend-core/PIN` and `integrations/erpnext-connector/contracts/backend-core/PIN` (RT-704), read from this repository's object store, against the in-tree file (`oasdiff breaking`, Backend-Core severity levels) | WARN or ERR finding; a PIN whose `repo:` is not this repository (`repository` in `config.yaml`) or whose `source:` is not `contracts_root` (RT-889); a `commit:` that is not in this repository's object store, or a `file:` blob that is not the blob of that path at the PIN's `commit:` (a partial or mixed pin, RT-1407); missing blob; vendored POS copy not hashing to its pin; pinned file gone from the tree; malformed PIN; any oasdiff error or unparseable output | every other change (`oasdiff changelog`); a stale pin, whose blob differs from the in-tree file even when oasdiff sees no API change (RT-1407) |
| `connector` | `connector/posting/contracts.py`, `connector/bin_view/contracts.py`, `connector/stock_import/contracts.py` and the tenant provisioner's `provisioner/feed_client.py` (RT-1359; only its `from_wire` models are field-checked, not the `FeedClient` request bodies or reads) (parsed with `ast`, never imported) against `posting-feed.yaml`, `stock-view.yaml`, `stock-import.yaml` and `provisioning-feed.yaml` | enum set ≠ schema `enum`/`const`; pattern ≠ schema `pattern` (`\d` = `[0-9]` only under `re.ASCII`; `\w`/`\s`/`\b` without `re.ASCII` fail); an integer constant mapped under `lengths` ≠ schema `maxLength` (RT-1458: the provisioner's `_MAX_SITE_NAME` vs `siteName`); a read whose key cannot be resolved; a field read or emitted that the schema lacks; a field read by bare subscript, or refused when absent by an unconditional top-level guard (`if x is None: raise`, `not x`, `"k" not in wire`, a literal or `isinstance` guard, also inside a helper that `from_wire` always calls), that the schema does not require (RT-1583); a field the Connector requires to be a JSON type the schema does not allow (a rejecting `if not isinstance(x, T): raise`, `Model.from_wire(x)`, or a conversion that cannot hold the schema's type), or a `to_wire` value of a type the schema does not allow (RT-1583); an unconditional `if x != "lit": raise` / `not in (...)` whose accepted values differ from the schema `enum`/`const` (RT-1583); a required field `to_wire` never emits; a class with `from_wire`/`to_wire` and no same-named schema; an unclassified module-level frozenset or `re.compile` | docstring version ≠ `info.version`; an equal pattern ending in Python `$`, which also accepts a trailing newline that the contract rejects |
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

Pin a commit that is on `main`: CI reads it from git, and a squash merge drops branch-only commits (the Connector script refuses any other commit). The check also applies in the System release gate, to each consumer PIN at its release commit: a Connector commit from before the RT-1407 repin that still carries the RT-1398 partial `stock-import.yaml` pin (#593 up to that repin) fails it, so name a later commit in a release manifest. Consumers lag `main` on purpose until they repin, so a pinned blob behind the in-tree file is a `stale pin` drift line in the job summary, not a failure.

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

1. **Connector types are compared only where the code states them (RT-1583).** A read-side type comes from a rejecting `if not isinstance(x, T): raise` (a branch on `isinstance` that does not reject is not a claim), from `Model.from_wire(x)` (an object), and through a module helper the field is passed to. `str(x)` and `int(x)` / `float(x)` are conversions, not assertions: they only rule out a type they cannot convert (an object or array, plus a boolean for the numeric ones), so `str(x)` on an integer field passes. For `to_wire`, the type of the literal, `str(...)`, list, dict or `.to_wire()` value stored under a key. A field whose use cannot be read this way (a custom parser, an expression, a `Decimal`) is not compared, so a type change there still passes. `integer` and `number` are interchangeable, and a lone `bool` guard next to an `int` check is not a type claim. A local name is followed only while it is bound once (or always to the same field).
2. **Inline literals are compared only as acceptance guards (RT-1583).** An unconditional top-level `if x != "lit": raise` or `if x not in ("a", "b"): raise` must accept exactly the schema's `enum` or `const`. A literal used to branch (`if kind == "void": ...`), nested in another condition, or tested after an early `return` is not an acceptance set and is not compared. A guard written as `==` ... `raise` (a rejected value) is not compared.
3. **Required-ness is read from bare subscripts and from unconditional guards (RT-1583).** `.get` followed by an unconditional top-level reject counts as required, also in a helper called from a top-level statement or from the final `return`. A guard that sits after an early `return`, a loop or a `try`, inside another branch, with an `else`, in a helper called only conditionally, or on a `.get(k, default)` with a non-`None` default (the default stands in for absence) does not (under-claims, never over-claims).
4. **No acknowledgement mechanism.** Unlike bc/oasdiff there is no ignore file; an accepted break needs a repin of the consumer, or an owner-approved allowlist added later. The owner deferred it on 2026-11-24 (RT-1583 P4), because the checks above found no drift on `main` that needed one.

Closed, no longer gaps: `consumers.txt` lists POS, admin and the Connector with their in-tree PIN paths (RT-680), and the POS `generated` rule is in `tools/project-graph/graph.yaml` (`apps/pos/src/shared/api-types.ts`). RT-868 scope items 2 and 3 are therefore done.
