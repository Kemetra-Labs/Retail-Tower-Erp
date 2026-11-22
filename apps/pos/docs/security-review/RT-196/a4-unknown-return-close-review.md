<!--
RT-1498 close slice (RT-196 S5: the status read and the close) — §A4 P8 bridge-security record.
Written with the implementation, before merge.
Scope: two new channels (`returns:readStatus`, `returns:close`), one new Backend-Core read client, five
new refusal reasons, three new main-only audit categories, no new migration, no new approval kind.
-->

# §A4 — P8 bridge-security record: read the server's verdict and close an unknown return (RT-1498 close slice)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-1498 (carried from RT-196), the close slice. Design: `docs/superpowers/specs/2026-10-18-rt-196-unknown-return-resolution-design.md` (§3.2 to §3.9, S5, OD-196-1, OD-196-5). Previous records: `a4-unknown-return-s1-review.md`, `a4-unknown-return-s4s5-review.md`. |
| Authority | RT-1498 comments 18144 (one approval kind, the disposition bound in; 0070 approved), 18177 (LOW-1, LOW-2), 18283 (the slice plan). RT-1548 comments 18215, 18216, 18225, 18265, 18278, 18281 (the affirmative read and the BR-7 bound, merged as `ef40cdd83`). Owner delegation to the orchestrator (chat 2026-11-22). |
| Gate | §A4 — P8 Electron security boundary: **two new channels**. A contract PIN move (`[GATED: contract pin]`, its own commit). No migration. |
| Bridge surface changed | `returns:readStatus` and `returns:close` (renderer → main), `ReturnsBridgeAPI.readStatus` / `.close`; five new refusal reasons (`reconcile_too_soon`, `quiet_period_unproven`, `send_in_flight`, `close_needs_not_recorded`, `read_unauthorized`). |
| NOT in this change | Confirming a return from a status read (a matching `recorded` answer writes nothing; the explicit resend confirms it through the dispatcher's own matcher). The automatic `auth_failure` flag and `return_journal_origin`. A persisted `needs_support` after a close (migration 0070 forbids it: see 4). |
| Prepared by | The implementation agent (Claude Code). A targeted agent review of the diff, **not** the full Electron audit and **not** an independent human review. |
| Verdict | **Agent-assessed PASS** for what ships, with finding F-1 open (the late commit after a close), pending the independent review of the diff. |

## 2. The channels

| # | Channel | Direction | Payload (closed shape) | Answer |
| :-- | :-- | :-- | :-- | :-- |
| C-1 | `returns:readStatus` | renderer → main | exactly `{ returnId }`, a canonical UUID (`readStatusRequest`) | `ReturnsReadStatusResponse`: `not_recorded`, `recorded`, `inconclusive` or `refused` (with `ret: null` on a malformed request) |
| C-2 | `returns:close` | renderer → main | exactly `{ returnId, approvalId }`, both canonical UUIDs (`readCloseRequest`) | `ReturnsCloseResponse`: `closed` or `refused` (with `ret: null` on a malformed request) |

Neither request carries a sale ref, a provenance, a verdict, a read time, a disposition, a reason, an
operator, a scope or an amount: main reads the sale and the provenance from the journaled row, takes the
verdict from the server, and the channel fixes the disposition.

## 3. Controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| K-1 | Closed request shapes; a smuggled key, a non-UUID, an array or a missing field is `invalid_input` and never reaches the service | `ipc/__tests__/returns-close.test.ts` |
| K-2 | Default deny while the session is locked (neither channel is on the lock allowlist); refused in recovery mode (`returns:` is a refused namespace) | `returns-close.test.ts` (IPC), `recovery-mode-guard.test.ts`, `bootstrap-ipc-channel-set.test.ts` |
| K-3 | Manager or admin only, feature flag, unlocked session and the shutdown latch, before any read (the admission gate `resend` and `escalate` use); the stop latch is re-checked first after the network await | `returns-close.test.ts` (main) |
| K-4 | Tenant and terminal isolation: the journaled row must be of this terminal (`return_not_found`, non-disclosing, no row shown); the sale ref asked of the server is the row's own, and the server scopes the read to the caller's tenant and store (a 404 for anything else) | `returns-close.test.ts`, RT-1548 `return-status-read.spec.ts` |
| K-5 | **A verdict is only an affirmative server answer.** `not_recorded` and `recorded` are the only 200 bodies that count. A 404 is `unavailable` (the returns gate or the status read's own rollout gate is off, or the sale is out of scope): never `not_recorded`, so a close is unavailable. A 5xx, 429, 401/403, a network fault, a timeout and an unreadable body are no verdict. Nothing is inferred locally (no `listSaleReturns`, no `returnedQuantity`). | `returns-status-client.test.ts`, `returns-close.test.ts` |
| K-6 | **The close needs a FRESH read at close time**, whatever an earlier read said, after the quiet period. A `recorded` answer never closes (a mismatch or a credit reversal hands the return to support, a match writes nothing); a 404 or no verdict refuses; a send that ran while the read was in flight makes the answer stale (`send_in_flight`). | `returns-close.test.ts` |
| K-7 | **The quiet period is ELAPSED time (15 minutes since the last send), shown or not elapsed.** Every attempt is anchored in memory at the stamp the journal records, on the monotonic clock and the wall clock; the check needs both to agree within 60 s. After an app restart (no anchor), a stepped clock (either way) or a journal stamp this process did not anchor, the period is unproven and a close is refused (`quiet_period_unproven`). No boot id is persisted, so no migration. | `returns-quiet-period.test.ts`, `returns-close.test.ts` |
| K-8 | **One approval kind, the disposition bound (Gap 1).** The close spends a `return.resolve_unknown` approval whose `subject_ref` is `<returnId>_close`; an approval for `escalate` is `approval_invalid` for a close and the reverse, and stays unspent. Granted under the reason `close_unknown`, to THIS operator as requester, by ANOTHER manager (four-eyes); bound to the row's state and attempt count (stale once it was attempted again) and to the quoted amount. The close subject exists only while the status read is available (the last probe was answered with a verdict; unknown means unavailable). Migration 0070's triggers repeat the binding at the table. | `returns-close.test.ts`, `returns-resolve-approval.test.ts`, `0070-return-journal-dispositions.test.ts` |
| K-9 | **Atomic.** The approval spend, the `not_recorded_closed` disposition and both audits commit in ONE local transaction; any refusal or a failed audit rolls the spend back (the approval is not burned). Single use; one close per return (partial unique index); two closes at once leave one. | `returns-close.test.ts`, `0070-return-journal-dispositions.test.ts` |
| K-10 | A close sends nothing and never confirms or refuses; a closed return is frozen in the journal (`trg_return_journal_closed_frozen`) and never sent again (the dispatch commit point), so it can never be payable. It frees the sale (`unresolved_return_exists` and the void guard clear), and the update safe point stops counting it (RT-1498 review LOW-2). | `returns-close.test.ts`, `returns-dispatch-hold.test.ts`, `safe-point-inputs.test.ts` |
| K-11 | `retry_hold` (the 0070 kind, first writer): written only by a `not_recorded` read, restrict-only, never a state, never frees the sale. It stops the background and bar sends while it is newer than the last attempt (re-read at the dispatch commit point, even from an earlier snapshot); only the explicit per-row resend moves the last attempt past it. Without it the resolver would resend at least every 5 minutes and the quiet period could never elapse. | `returns-dispatch-hold.test.ts`, `returns-dispositions-repository.test.ts` |
| K-12 | Credentials: the operator envelope of the admitted authorization snapshot is the bearer (as `readSale`), passed explicitly; the client reads no session or token, and never logs, stores or bridges one. Built on the shared transport (RT-880): bounded body, timeout, faults to no verdict. No envelope, no request. | `returns-status-client.test.ts`, conformance suite (`returnsStatusClient.readStatus`) |
| K-13 | Audit: new MAIN-ONLY categories `sale.return.status_read`, `sale.return.closed_not_recorded` and `sale.return.late_commit_after_close`, ids and closed codes only (no PIN, body or envelope); the approving manager is `approving_supervisor_id`. A renderer cannot forge them. | `operator-emit-audit-event.test.ts`, `returns-close.test.ts` |
| K-14 | The renderer never decides an outcome: it names a return, shows what main answered, and re-reads the journal after any answer. «إغلاق كمرتجع غير مسجَّل» is offered only after a read that answered an affirmative `not_recorded` with the period over, for that return, while its last attempt is the one the read covered; main re-checks on its own. The PIN is cleared on the press and never stored or logged. | `returns-history-close.test.tsx` |
| K-15 | Return idempotency is untouched: the journaled bytes, the key and the dispatcher's send path are unchanged; the status read is a GET and never POSTs. | `returns-dispatch*.test.ts` (unchanged), diff |

## 4. Findings

| # | Finding | Status |
| :-- | :-- | :-- |
| F-1 | **Late commit after a close cannot be persisted as `needs_support`.** RT-1548 obliges the POS to treat a closed return that is later seen as recorded as a mismatch, raise it to support (`needs_support`) and never pay cash on it. Migration 0070's `trg_return_journal_dispositions_header` refuses ANY disposition after a close, and 0070 is merged and not changed here. What ships instead: a status read of a closed return that finds the key recorded writes the audit `sale.return.late_commit_after_close` (return ref, credit flag), tells the manager to contact support, and nothing can pay (a closed return is frozen and never confirmable; the payout needs `confirmed`). What is missing: a durable flag that survives the audit retention window and re-blocks the freed sale. | **Open, owner decision.** A persisted flag needs a successor migration (GATED) that lets a `needs_support` follow a close, or a different record. Not built. |
| F-2 | The quiet-period anchor lives in memory, so a restart makes the period unproven and the manager must resend (a new anchor) and wait again. A deliberate fail-closed cost of needing no migration. | Accepted, by design. |
| F-3 | The status-read availability is per process and starts unavailable; it is set by the first status read that answers. A close approval therefore needs one prior read in this run of the app (the UI offers the close only after one anyway). | Accepted, by design. |

## 5. Out of scope / owed

Confirm-by-read (a matching `recorded` answer confirming the return so payout is allowed), the automatic
`auth_failure` flag (needs the 3-attempt history), `return_journal_origin` (true four-eyes against the
return's originating user), the shift-close warning (S7), the packaged-POS proof (S8), the owner's review
of the PROPOSED Arabic copy, and the owner's replication-setting verification that turns the server read on
(RT-1548: `POS_RETURN_STATUS_READ_ENABLED` stays off until then, so every read answers 404 and a close is
unavailable).
