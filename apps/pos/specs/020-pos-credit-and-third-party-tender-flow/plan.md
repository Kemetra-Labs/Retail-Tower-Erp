# Implementation Plan: POS Credit & Third-Party Payer Flow

**Feature ID:** 020-pos-credit-and-third-party-tender-flow
**Spec:** [./spec.md](./spec.md)
**Plan version:** 2.0 (RT-420 re-scope, 2026-11-22; baseline `origin/main` `510706c4d`)

> **Artifact class: docs only.** This plan describes the later implementation issue (spec D-5) at the
> altitude needed to size and order it. It authorizes no product code, no contract edit, no migration, no
> package change and no CI change.

## Official-first (short form)

```
Official capability / docs + version: Backend-Core contracts on main: sales.yaml captureSale `responsibilities`
  (RT-417, pin 1.28.0-draft) and pos-payers.openapi.yaml posListChargeablePayers (RT-570, 1.0.0-draft, runtime RT-802).
Existing Retail Tower implementation: capture client and engine in apps/pos/src/main/sales-sync/ (envelope path;
  device path in compose-device-path.ts); bootstrap/sale-sync.ts; bootstrap/sale-void.ts as the existing
  synchronous envelope precedent; shared backend transport src/main/http/transport.ts (RT-880).
Decision: REUSE the two consumed operations and the existing capture client and transport; EXTEND the till flow.
  No BUILD of a contract, receivable, balance or cache.
Why: R-1 puts the allocation in the sale; the payer read already exists server-side.
Safety: Backend-Core owns allocation, ERPNext owns A/R; POS never calls ERPNext; no offline credit; the device
  path never carries a responsibility; no tax split; contract pin is a separate gated change.
```

## Technical context

| Area | Choice | Source |
|:--|:--|:--|
| Consumed operations | `captureSale` with `responsibilities`; `posListChargeablePayers` | spec section 0 |
| Credential | Operator envelope only (manager/admin session) | R-PATH, R-ROLE |
| Capture mode | Synchronous, online, before finalize; not in `sale_sync_outbox` | R-SYNC, R-OFFLINE |
| Payer read | Online per picker opening; no persistence, no cache | R-FRESH |
| Money | Integer minor units inside; exact-decimal strings on the wire | NFR-2 |
| Idempotency | Existing deterministic key; key and frozen body stored before first send | FR-8 |
| HTTP | Shared `createBackendTransport` for the new payer client (RT-880) | `apps/pos/CLAUDE.md` |
| Wiring | New area in `src/main/bootstrap/<area>.ts`, nothing added to `index.ts` (RT-893) | `apps/pos/CLAUDE.md` |

## Constitution and invariants check (design altitude)

| Principle | Status | Note |
|:--|:--:|:--|
| Offline-first | PASS with a stated exception | Credit is the one capability that is online-only by owner decision; every other sale path is unchanged. |
| Financial precision | PASS | Exact arithmetic, no floats. |
| Process boundary | PASS | Main process decides and sends; renderer displays and requests (RT-24 I-1). |
| No fake success | PASS | Finalize only after acceptance; credit never shown as paid (RT-24 core rule 2). |
| No silent loss | PASS, one open item | Cart is never lost; the cash-after-refusal mechanism is Q-2. |
| Terminal identity is not a user | PASS | Envelope operator, not device token. |
| Platform integration | PASS | Backend-Core only. |
| Domain limits (I-17) | PASS | No insurance, prescription or claim wording. |

## Phases for the later implementation issue (ordered)

1. **Pin (gated, own PR).** Vendor `pos-payers.openapi.yaml`, regenerate the client and snapshot. Needs
   `[GATED: contract pin]`, a narrow source-scope-guard exemption on its branch, and a CircleCI `pos`
   preflight under the RT-981 rules. Nothing else can start before it.
2. **Payer client (main).** Read-only client on the shared transport; returns pages, never persists; maps
   401, 403, 400, 429, 5xx and transport faults to typed results.
3. **Credit capture mode (main).** A capture path for a responsibility-bearing sale: frozen body and key
   stored with the checkout attempt, one synchronous send, finalize on acceptance, transient retry with the
   same key, never queued, never the device bearer.
4. **Checkout UI (renderer).** Credit option (role and connectivity gated), payer picker (online, device
   filter, greyed unlinked payers), amount entry, remainder, coverage check with persistent reason, commit.
5. **Receipt line.** Payer responsibility line without a "paid" claim (Q-5, Q-6).
6. **Guards.** Void and return screens refuse the ordinary route for a credit sale with a reasoned block
   (Q-7); audit events; telemetry allowlist unchanged.
7. **Evidence.** Behavioral-tier tests (sales and money paths), packaged-app run against the lab for the
   happy path and the offline refusal. The end-to-end proof also needs RT-419 (posting to the payer's
   Customer); until then state "capture proven, posting held".

## Test strategy (for the implementation issue)

- **Coverage pre-check:** table-driven exact-arithmetic tests (part credit, full credit, zero, negative,
  above total, change interaction).
- **Mode isolation:** a sale with a responsibility never enters `sale_sync_outbox` and never uses the device
  path, even with a selling cashier id (scenarios 5, 6).
- **Outcome matrix:** one test per row of the consumption note, including "no finalize except accepted".
- **Idempotency:** restart between send and response replays the same key and body (scenario 11).
- **Payer read:** nothing is persisted, nothing shown while offline, `chargeable: false` is never submitted
  (scenarios 4, 9, 10).
- **Receipt:** golden snapshot with the payer line; assert no "paid" wording on the credit line.
- **Coverage gates:** run the new files with the per-file coverage gate before the first push (see skill
  `merging-rt-pull-requests`).

## Risks and open items

- **Owner questions Q-1 to Q-8** in the spec block the implementation issue, not this docs change.
- **Pin missing (D-1).** Until it merges the till cannot read payers.
- **Posting held (D-3, RT-419).** A captured credit sale is held in the posting feed until the Connector
  supports it, so there is no ERPNext proof yet.
- **Single payer.** A split sale needs a later contract version.
- **Admin Console specs 017 to 019** still describe the retired model (spec D-7).
- **Insurer category** (Q-4) is a Backend-Core enum POS cannot change.

## Follow-ups outside this change (not done here)

`apps/pos/README.md` line 132 row wording; the unnumbered `0xx-insurance-copay` spike (prior art only, not
an authority); the Admin Console specs 017 to 019; the vendored `sales.yaml` prose that still names the old
route and spec FR-5; the implementation issue itself.
