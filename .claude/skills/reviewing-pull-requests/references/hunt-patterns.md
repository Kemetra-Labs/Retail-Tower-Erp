# Hunt patterns

Concrete defect shapes behind real Major/Minor findings from CodeRabbit (Khepri) and
Codex (POS-Pulse) reviews. Each entry: the shape, the question that finds it, and how
to prove it. Use these as prompts for your own reading — not as a checklist to pattern
match against. A finding still needs its own failure scenario.

## Contents
1. Concurrency and stale state
2. Constraints, scope, and contracts
3. Edge values and vacuous truth
4. Partial failure and lifecycle
5. Tests and guards that cannot fail
6. Scripts, CI, and ops files
7. Specs, plans, and docs
8. When a finding is probably wrong

---

## 1. Concurrency and stale state

- **Read → await → act on the old read.** A value (session, authority, clock, pairing,
  status) is read, then an await/IO happens, then the old value gates an action.
  Revocation, sign-out, expiry or a cancel can land in between.
  *Ask:* "What can change during this await, and is it re-checked after?"
  *Seen:* clock read before `resume` let expired content get a 7-day cookie; lookup data
  returned after the session switched to a less-privileged user.
- **Stale responses after cancel/remount.** A UI or worker issues request A, the user
  cancels or the component remounts, request B starts, then A's late response is applied.
  *Ask:* "Is each response matched to the request/epoch that is still current?"
- **Success that looks like failure.** The write committed but the promise rejected (lost
  response, follow-up read failed). Code treats it as "not done" and retries or hides it.
  *Ask:* "If the server did it but we never heard back, what does the caller believe?"
- **Two instances / two processes.** Shared DB or file, two app instances racing on the
  same row. Look for check-then-insert without a unique constraint or lock.

Prove it: name the interleaving step by step (`T1 reads… T2 commits… T1 writes…`). For
SQL, check isolation level and whether a `FOR UPDATE`/unique index exists.

## 2. Constraints, scope, and contracts

- **Existence ≠ ownership.** An FK or lookup proves the referenced row exists, not that
  it belongs to the same tenant/session/scope. *Seen:* a profile could reference another
  scope's upload; migration repaired only dangling IDs, not mismatched-scope rows.
  *Ask:* "Could this id legally point at someone else's row?"
- **Contract changed in one place.** A new enum value / refusal reason / field added to
  one list but not to the bridge contract, schema, serializer, or docs that mirror it.
  *Ask:* `grep` every place the old set of values is enumerated.
- **Units / basis drift.** A value is withheld or refused, but sibling fields that
  describe it (currency, basis, units) still claim it is present.
- **Legacy data.** New invariant enforced for new writes only; existing rows violate it.

## 3. Edge values and vacuous truth

- `all()` / `every()` over an empty collection is true; `any()`/`some()` is false. A check
  that "every X is valid" passes when there are zero X.
- Empty string vs missing vs null: `display_name: ""` may be admitted by the contract
  but rejected (or treated as missing) by a truthiness check.
- Safe-integer / overflow on aggregates (each item valid, the sum not).
- Same-millisecond timestamps at a boundary (`<` vs `<=`).
- Substring checks standing in for parsing (`'self'` in a CSP string passes for
  `'self' https://evil`).

## 4. Partial failure and lifecycle

- Multi-step operation where step 2 fails after step 1 committed: is the tombstone /
  retry state preserved, and does the retry still have the inputs it needs (old epoch,
  original reason)?
- Shutdown closes the DB while a tick/request is still awaiting.
- A hook/callback that throws aborts the surrounding critical path.
- Re-applying config/roles: `CREATE IF NOT EXISTS` + partial `ALTER` leaves old
  attributes (e.g., an existing role keeps `SUPERUSER`/`BYPASSRLS`).

## 5. Tests and guards that cannot fail

- **Tautology:** the expectation is derived from the same artifact under test, so editing
  one edits both. *Ask:* "Which file holds the expectation, and does this change edit it?"
- **Weak guard before a destructive action:** "name contains `test`" accepts `latest`,
  `contest_prod`. Guards before `DROP`/`DELETE`/`rm -rf` deserve a Major.
- **Over-broad xfail/skip/catch:** marks or `except` that also swallow unrelated errors
  (`TypeError` reported as expected failure). Prefer `raises=`/specific exception.
- A test that asserts on the mock it configured.

## 6. Scripts, CI, and ops files

- Shell: does a failing step actually stop the script (`set -e` semantics inside
  pipelines, `$(...)`, `if`, `||`)? Are statuses captured before being overwritten?
- Truncated identifiers (short image IDs/SHAs) where uniqueness matters.
- Log/evidence collection that fails silently, leaving a report that looks complete.
- Ops SQL/scripts claiming idempotence: run them mentally twice.

## 7. Specs, plans, and docs

Treat each normative sentence (MUST/requires/verifies/"every") as code:
- **Claim wider than evidence:** "every verdict below is from the pinned renders" when
  some came from another source; "verified on the report surfaces" when the table shows
  three of them.
- **Requirement that names a hole but doesn't close it:** the stated check runs at a
  different time or place than the risk.
- **Internal contradiction:** two sections describe the same behavior differently; a
  superseded statement left live; section numbers/citations duplicated.
- **Plan ≠ implementation:** the plan requires X, the code/validation asserts not-X.
- **Unpinned decisions:** a version/identifier "must move" without naming the new value,
  so two implementers diverge.
- **Security requirements stated by name only** ("pinned search_path") without the
  properties that make them safe.
- **Verification scenarios read as a program.** Walk each scenario step by step with its
  data: after step 2 deletes, purges, consumes or rewrites the shared fixture, can step 3
  still observe the thing it claims to verify? A sequence of assertions sharing one fixture
  often makes the later ones vacuous. Same for checks placed *before* a window ("verified
  before the pass") — they say nothing about what happens *during* it.

## 8. When a finding is probably wrong

CodeRabbit withdrew about a third of its findings after the author replied. Before
reporting, check the common reasons:
- The path is unreachable through the current writer/caller (still worth a Minor if the
  DB/contract permits it, but say so).
- A guard elsewhere already covers it (CI script, wrapper, middleware) — grep for it.
- The change is out of the PR's stated scope; the defect pre-exists. Report it as
  "pre-existing, out of scope" rather than as a regression.
- The library actually handles it (e.g., driver infers the bind type). Check the docs
  or the source before claiming.
- The file is a verbatim vendored/reference copy that is intentionally not edited.
