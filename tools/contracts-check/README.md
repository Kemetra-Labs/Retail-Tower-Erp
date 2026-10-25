# tools/contracts-check

`contracts/check` (RT-868, decision [MR-2](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/55771138)): every consumer is checked against the in-tree Backend-Core contract `services/backend-core/packages/contracts/openapi` at the same commit, so a change that breaks POS, Admin-Console or the Connector fails in the PR that makes it. Run by `.github/workflows/contracts.yml`.

## Checks

| Check | Compares | Fails on | Reported, not failing |
| --- | --- | --- | --- |
| `pins` | each `file: <path> <blob>` of `apps/pos/contracts/backend-core/PIN` and `apps/admin-console/contracts/backend-core/PIN`, read from this repository's object store, against the in-tree file (`oasdiff breaking`, Backend-Core severity levels) | WARN or ERR finding; missing blob; vendored POS copy not hashing to its pin; pinned file gone from the tree; malformed PIN; any oasdiff error or unparseable output | every other change (`oasdiff changelog`) |
| `connector` | `connector/posting/contracts.py` and `connector/bin_view/contracts.py` (parsed with `ast`, never imported) against `posting-feed.yaml` and `stock-view.yaml` | enum set ≠ schema `enum`/`const`; pattern ≠ schema `pattern` (`\d` = `[0-9]` only under `re.ASCII`; `\w`/`\s`/`\b` without `re.ASCII` fail); a read whose key cannot be resolved; a field read or emitted that the schema lacks; a field read by bare subscript that the schema does not require; a required field `to_wire` never emits; a class with `from_wire`/`to_wire` and no same-named schema; an unclassified module-level frozenset or `re.compile` | docstring version ≠ `info.version`; an equal pattern ending in Python `$`, which also accepts a trailing newline that the contract rejects |
| `identical` | each group under `identical:` in `config.yaml`: the four `obs1-golden-vectors.json` copies and the four `rt879-redaction-vectors.json` copies (RT-879) | any byte difference or missing copy | — |

Everything that cannot be compared fails (fail closed). The mapping of Connector constants to schema locations is in `config.yaml`; a new constant must be mapped or listed as `local` with a reason.

## Commands

```bash
cd tools/contracts-check
python -m pip install --require-hashes --only-binary=:all: --no-deps -r ../project-graph/requirements.txt
CONTRACTS_CHECK_OASDIFF=/path/to/oasdiff python -m unittest discover -s tests -v
python -m contracts_check --repo ../.. --oasdiff /path/to/oasdiff [--summary summary.md] [--only pins|connector|identical]
```

`oasdiff` is the bc/oasdiff pin (1.32.1, sha256-verified). Without `CONTRACTS_CHECK_OASDIFF` the real-oasdiff tests are skipped locally; CI always sets it. The check needs full history (`fetch-depth: 0`) because pinned blobs come from older commits.

## Known gaps (named, not silently relaxed)

1. **Connector types are not compared.** Only names, enums, patterns and required-ness: a field that changes from string to object passes this check.
2. **Inline literals are not compared**, such as `RefundTender` accepting only `"cash"` or `ErpnextItemRef.doctype == "Item"`; only module-level constants are.
3. **Required-ness is read from bare subscripts.** A field read with `.get` and then rejected when absent counts as optional (under-claims, never over-claims).
4. **`consumers.txt` and the POS `generated` rule** (RT-868 scope items 2 and 3) are in `services/` and `apps/`, outside this Shadow-native slice (MR-7).
5. **No acknowledgement mechanism.** Unlike bc/oasdiff there is no ignore file; an accepted break needs a repin of the consumer, or an owner-approved allowlist added later.
