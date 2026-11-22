<!--
RT-1498 S4/S5 (RT-196 S4 + the part of S5 that needs no new server read) — §A4 P8 bridge-security
record. Written with the implementation, before merge.
Scope: the new `returns:escalate` channel, one new manager-approval kind, three new refusal
reasons, one main-only audit category and one additive payload field.
-->

# §A4 — P8 bridge-security record: hand an unknown return to support (RT-1498 S4/S5)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-1498 (carried from RT-196), slices S4 and S5. Design: `docs/superpowers/specs/2026-10-18-rt-196-unknown-return-resolution-design.md` (§3.3, §3.4, §3.6). Previous record: `a4-unknown-return-s1-review.md`. |
| Owner decisions | RT-1498 comment 18144 (2026-11-21): (1) **one** approval kind, the disposition bound into the approval payload (no second kind); (2) a GATED POS migration, an append-only local dispositions table, number **0070**; (3) RT-196 comment 12801 gaps 2 and 3 follow the proposals recorded in PR #786; (4) any Backend-Core read or contract change stops the work. |
| Gate | §A4 — P8 Electron security boundary: **one new channel** (`returns:escalate`). GATED migration `0070`. |
| GATED migration `0070` | One new table, `return_journal_dispositions`, with its indexes and triggers, **and one trigger on the existing 0039 `return_journal` table**, `trg_return_journal_closed_frozen`. That trigger changes no column and no existing object, is inert until a `not_recorded_closed` disposition exists (no code writes one yet), and then freezes `state`, `attempt_count` and `last_attempt_at` of that closed return. Precedent: 0040 and 0053. Accepted by the orchestrator under owner delegation (RT-1498 comment 18177, MEDIUM-1). |
| Bridge surface changed | `returns:escalate` (renderer → main) and `ReturnsBridgeAPI.escalate`; `ReturnJournalView.disposition` (additive, closed set); three new refusal reasons (`never_sent`, `approval_invalid`, `approval_stale`). |
| NOT in this change | `returns:close`, the status read, `retry_hold`, the automatic `auth_failure` flag. See section 5. |
| Prepared by | The implementation agent (Claude Code). A targeted agent review of the diff, **not** the full Electron audit and **not** an independent human review. |
| Verdict | **Agent-assessed PASS** for what ships, pending the independent review of the diff. |

## 2. The channel

| # | Channel | Direction | Payload (closed shape) | Answer |
| :-- | :-- | :-- | :-- | :-- |
| C-1 | `returns:escalate` | renderer → main | exactly `{ returnId, approvalId }`, both canonical UUIDs, closed key set (`readEscalateRequest`) | `ReturnsEscalateResponse`: `escalated` or `refused` (with `ret: null`, like `resend`) |

There is no disposition, reason, operator, scope, amount or approver in the request: the channel fixes
the disposition (`escalate`), and main reads everything else from the journaled row and from the
approval it spends.

## 3. Controls

| # | Control | Evidence |
| :-- | :-- | :-- |
| E-1 | Closed request shape; a smuggled key, a non-UUID, an array or a missing field is `invalid_input` and never reaches the service | `ipc/__tests__/returns-escalate.test.ts` |
| E-2 | Default deny while the session is locked (the channel is not on the lock allowlist); refused in recovery mode (`returns:` is a refused namespace) | `returns-escalate.test.ts` (IPC), `recovery-mode-guard.test.ts`, `bootstrap-ipc-channel-set.test.ts` |
| E-3 | Manager or admin only, feature flag, unlocked session and the shutdown latch, before any read (the admission gate `resend` uses). The approval request itself is refused to a cashier (`not_applicable`). | `returns-escalate.test.ts`, `returns-resolve-approval.e2e.test.ts` |
| E-4 | Tenant and terminal isolation: the journaled row must be of this terminal (`return_not_found`, non-disclosing); the approval resolver names a subject only for a return of the live paired terminal and the session's tenant and branch | `returns-escalate.test.ts`, `returns-resolve-approval.test.ts` |
| E-5 | **One approval kind, the disposition bound (Gap 1).** `return.resolve_unknown`; the approval's `subject_ref` is `<returnId>_escalate` (`_close` for a close). The approval service compares it for equality on consume, so an approval for one disposition is `approval_invalid` for the other and stays unspent. Migration 0070 repeats the rule in a trigger on the disposition row, and the same trigger also requires the approval's requester operator to be the disposition's actor and its approver to differ from its requester (as 0069 does; RT-1498 review MEDIUM-2). | `returns-resolve-approval.e2e.test.ts`, `0070-return-journal-dispositions.test.ts` |
| E-6 | Four-eyes: the requester must be a manager or admin session and a **different** manager approves (the approval service's default branch); main re-proves it from the approval's evidence (requester = the live operator's `users.id`, approver differs). The originating `users.id` of the return is not captured (RT-196 §9): four-eyes excludes only the requester, and the audit says `origin_user_unknown: true`. | `returns-resolve-approval.e2e.test.ts`, `returns-escalate.test.ts` |
| E-7 | Single use and staleness: the approval is spent in the SAME local transaction as the disposition and its audit, so any refusal rolls the spend back; it is bound to the row's state and attempt count (`approval_stale` once the return was attempted again), to the quoted amount and to the escalate reason code; one approval can back one disposition (unique index). | `returns-escalate.test.ts`, `0070-return-journal-dispositions.test.ts` |
| E-8 | It only restricts. A `needs_support` return stays unresolved: it keeps blocking new returns and voids on its sale (OD-196-4), and it can still be confirmed by a matching answer. It never writes `confirmed` or `refused`, never enables a payout, never frees the sale. Only a close frees the sale, and no code path writes a close yet. | `returns-dispositions-repository.test.ts`, `returns-escalate.test.ts` |
| E-9 | No automatic resend: the resolver, the bar pass and a first send are held at the dispatch commit point, re-read right before the POST, even from a snapshot taken earlier. Only the explicit per-row «إعادة الإرسال» sends it. Return idempotency is untouched: the same journaled bytes under the same key. | `returns-dispatch-dispositions.test.ts` |
| E-10 | A closed return is never sent again by any path and cannot change in the journal: `trg_return_journal_closed_frozen`, a trigger **added on the existing 0039 `return_journal` table** (no column changed, inert until a close exists), freezes `state`, `attempt_count` and `last_attempt_at` once a close exists. | `0070-return-journal-dispositions.test.ts` |
| E-11 | Audit: new MAIN-ONLY category `sale.return.needs_support`, payload `return_id`, `approval_id`, `verdict_source`, `reason`, `origin_user_unknown`; ids and closed codes only (no PIN, body or envelope); the approving manager is `approving_supervisor_id`. A renderer cannot forge it. | `operator-emit-audit-event.test.ts`, `returns-escalate.test.ts` |
| E-12 | The renderer never decides an outcome. «حُوّل إلى الدعم» is announced only after main answered `escalated`, with an `info` tone (the return is still unresolved). The PIN is cleared on the press and never stored or logged (`ManagerPinDialog`). The manager list is read once per sheet. | `returns-history-escalate.test.tsx` |
| E-13 | Credentials: unchanged. The envelope is read only by the authorizer; nothing here sends to Backend-Core. No Backend-Core, contract, package, lockfile or CI change. | diff |

## 4. Findings

None from the targeted review (pending the independent review of the diff).

## 5. Out of scope / owed (RT-1498 C0)

The server read `readReturnByProvenance` is on `main` (contract and runtime), but it answers
`200 ReturnRead` or a single non-disclosing `404`, and the contract itself says a 404 is not proof of
"never recorded". The design needs an AFFIRMATIVE `not_recorded` (BR-2) and a processing bound (BR-7).
Until the owner decides how to obtain them (a Backend-Core change, or an explicit POS-side rule), these
stay owed and are NOT wired: the status read client, the `not_recorded` verdict, the close writer and
its rules (fresh read, quiet period, `send_in_flight`), `returns:close`, the `retry_hold` writer, and
the automatic `auth_failure` flag. Migration 0070, the approval kind and every reader already honour a
close; only its writer waits.
