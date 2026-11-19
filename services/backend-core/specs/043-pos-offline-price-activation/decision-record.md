# Spec 043 — Decision record: G4-1 to G4-14 (RT-487, Pricing Gate 4)

**Status:** decisions were first **selected** by the coordinator under the owner's standing delegation (2026-10-18). On
2026-11-19 the owner gave **preliminary** approval with changes (RT-487 comments 17645, 17655, 17659). This record carries
those changes (RT-1492). The approval is **preliminary**: it settles design direction only. It authorizes no contract,
migration, POS or runtime work, and it does not make RT-1486 ready. **G4a is not met yet**: the G4-5 restart behaviour
below needs final owner ratification. Each original decision below is still marked:

> **Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.**

The owner disposition table that follows overrides those marks where the two differ.

Ratifying this record meets **G4a** (RT-282 §2) and unlocks the G4-gated items PR-06, PR-11, PR-12 and PR-P1 (and the
G4a-gated second PR-05 migration). It does not close G4: runtime closure (**G4b**) is PR-V2.

## Owner disposition (2026-11-19, preliminary; RT-487 c17645, c17655, c17659; aligned by RT-1492)

| Decision | Disposition | What changed in this record and in [design.md](design.md) |
|---|---|---|
| G4-1, G4-2, G4-4, G4-8, G4-10, G4-11, G4-12, G4-13, G4-14 | Approved as selected | Unchanged. G4-8 stays interim until the RT-284 bundle **runtime** ships; RT-284 Planning Done does not prove that runtime exists. G4-11 is gated by RT-1151 (PR-07). G4-12 and G4-2 are gated by the RT-1485 cutover |
| **G4-3** | Approved **with change**, as a **gated post-pilot target** | Approved target, not shipped. It supersedes spec 041 Q-3 only for pricing revalidation. Gated on RT-279 owning a reviewed timezone-history and update contract (**Needs verification**). See G4-3 below |
| **G4-5** | Approved **with change** | The single shared Offer Pack trusted clock is extended with the sealed marks. The `unverified` wall-time activation path is **removed**. The fail-safe restart treatment that replaces it is **Needs owner ratification** before it is binding |
| **G4-6** | Approved, **amended** to follow G4-5 | `unverified` no longer activates from the wall clock |
| **G4-7** | Approved **as selected**, owner clarification c17659 | 12 h is the warning. 24 h is the **stale threshold**, not a selling cut-off. The 72 h value is a **configuration clamp**, unchanged. Owner c17659 supersedes c17655 / c17657 on this point |
| **G4-9** | Approved **split** | Now: the `critical` flag, manifest `urgent`, `critical_not_applied` and `sold_before_correction`. **Deferred:** per-line `offlinePolicy` and the open-cart old/new acceptance |
| Emergency approval (design §2.1 B5) | Spec 042 is authoritative | Emergency publish needs **prior independent approval** (spec 042 §7, Q-B3). B5 is corrected |

**What "may revisit" costs.** Nothing here is in OpenAPI, a migration or code. A reversal before PR-05/PR-06/PR-07 merge
costs a doc change. After they merge, it is a gated contract or migration change, and on the POS a local migration.

Design: [design.md](design.md). Section references (§) are to it.

---

## G4-1 — Who converts store-local time to instants

| Option | Content |
|---|---|
| **A (recommended)** | Backend-Core converts every segment bound to an **absolute instant for that Store** (spec 041 §4.3 rules). POS compares instants only. |
| B | Send local bounds plus the Store's IANA zone; POS converts. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: the POS zone is a build constant that is deliberately not read from settings (POS `src/shared/time/business-day.ts`),
and DST rules then live in one place, the resolver. Cost: a Store zone change must re-deliver (G4-3).

## G4-2 — Where pricing travels to POS

| Option | Content |
|---|---|
| **A (recommended)** | A **separate pricing projection stream** (`/api/pos/v1/pricing/manifest | snapshot | acks`), keyed by store revision, next to the unchanged catalogue read-down. Under `pricing` authority the catalogue includes active products without a current price, and POS decides sellability from the applied projection. |
| B | Extend catalogue read-down rows with revision-tagged price fields and future entries. Coherence would have to follow both `catalog_change_log.sequence` and the pricing revision page by page. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: the coherence unit of pricing is the revision (628), not the catalogue's global change-log position; spec 010 stays
untouched; legacy and pricing authority never mix on one device. Consequence carried to RT-485/PR-16b: the catalogue
sellable filter and the manifest `authority` flip together per tenant (§5.2, §11).

## G4-3 — Identity of what a device applies

| Option | Content |
|---|---|
| **A (recommended)** | The pair **`(storeRevision, timeBasisEpoch)`**, ordered lexicographically. `timeBasisEpoch` rises when the Store's zone changes (under the pricing publish lock), and BC keeps an insert-only epoch → zone history so sales priced under an old epoch revalidate with the zone that was in force. A lower pair is a downgrade and is refused. |
| B | `storeRevision` only; a zone change publishes a synthetic pricing revision fanned out to the Store. Needs a revision kind without a Change Set. |
| C | `storeRevision` only; ignore zone changes until the next revision. Leaves wrong instants on devices. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: OD-3's revision stays one number per publish; a zone change (spec 038) creates no pricing revision (spec 042 Q-B8) yet
moves instants, so it needs its own counter.

**Owner disposition (2026-11-19, preliminary): approved with change, as a gated post-pilot target.**
- **Target:** the pair is applied atomically, and it never goes backward (a lower pair is refused). The per-Store
  epoch → IANA zone history is append-only, so a sale priced under an older epoch revalidates with the zone of that
  epoch.
- **How a zone change happens:** it increments the epoch under the pricing publish lock, and it makes affected Change
  Sets stale (spec 042 §8, Q-B8).
- **Spec 041 Q-3:** this supersedes the v1 "current zone" answer **for pricing revalidation only**. Q-3's limitation
  still holds for general historical inquiry and for everything that ships before this target.
- **Readiness gate:** RT-279 must own and identify a reviewed, bounded contract for store time-zone history and zone
  updates before G4-3 is implemented. That contract is **Needs verification**; nothing on `main` provides it today.

## G4-4 — Pre-delivery horizon and the use of `earliest_effective_at`

| Option | Content |
|---|---|
| **A (recommended)** | Deliver the **whole future timeline** per key in every projection (no window). `earliest_effective_at` drives only Health (`pre_delivery_at_risk` from `earliest_effective_at − preDeliveryWarnLead`, default 2 h; `missed_pre_delivery` at each Store's exact first activation) and manifest `urgent`. |
| B | Deliver a sliding window (e.g. 14 days). The projection then depends on time as well as revision, and a device offline past the window loses future prices. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: future events are few per key (one active per scope per instant), and the projection stays a function of the pair.
A window is a later optimisation if size metrics require it.

## G4-5 — Trusted time model

| Option | Content |
|---|---|
| **A (recommended)** | **Server-anchored monotonic clock + two sealed marks** (generalising the offline-grant mark): `hwm_trusted`, raised **only from anchored time**, and `wall_seen`, raised from the wall clock and used **only to detect rollback**. Anchor = `serverTime` from any manifest with RTT ≤ 5 s; `t_lo = max(hwm_trusted, serverTime + Δmono)`; after restart or OS resume (`unverified`) `t_lo = max(hwm_trusted, min(wall, hwm_trusted + maxStaleness))`. **Activation uses the lower bound `t_lo`; staleness uses the upper bound `t_hi = max(t_lo, wall)`.** At re-anchor, a wall clock that ran ahead or was rolled back produces a reported **clock incident**. Drift budget 120 s; rollback tolerance 5 min. |
| B | Wall clock with skew detection only. Easy to roll back to keep an old price. |
| C | Server-signed activation tokens per revision. Needs signing keys and still needs local time to know *when* to use them. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
*Superseded in part (2026-11-19, RT-1492):* the `unverified` formula in Option A and the "bounded by `maxStaleness`"
reasoning below are historical. Read the owner disposition after this section.
Why (original): it reuses machinery the POS already has, closes rollback, biases activation late and staleness early, and keeps
untrusted wall time out of the trusted floor, so a re-anchor always restores correct activation. The remaining risk
(forward tampering after an offline restart) is bounded by `maxStaleness` and detected through clock incidents (G4-13),
except when the device stays offline until real time overtakes the forged time. That case is stated as undetectable. A signed manifest stays optional
hardening (RT-284 Q7 precedent).

**Owner disposition (2026-11-19, preliminary): approved with change.**

- **One clock.** POS keeps a **single shared** trusted clock. It generalises the existing Offer Pack server anchor
  (`apps/pos/src/main/offers/offer-pack-service.ts`: anchor = server time of the last read plus monotonic elapsed time;
  the wall clock is used only to refuse; the anchor lives in memory only). It is extended with the two sealed marks:
  `hwm_trusted`, raised **only** from anchored time, and `wall_seen`, a rollback detector. Pricing and offers use the
  same module, not two parallel clocks.
- **Kept unchanged:** the RTT ≤ 5 s anchor rule, the 120 s drift budget, the 5 min rollback tolerance, clock incidents,
  and the upper bound `t_hi` for staleness. Staleness is never hidden.
- **Removed:** the authored `unverified` rule `t_lo = max(hwm_trusted, min(wall, hwm_trusted + maxStaleness))`. Untrusted
  workstation time no longer advances activation after a restart or an OS resume.
- **Fail-safe replacement (Needs owner ratification before it is binding):**
  - While `unverified`, `t_lo = hwm_trusted`. Activation is **frozen** at the last trusted instant: no **new**
    scheduled price activates, and nothing un-activates.
  - Selling continues from the applied projection at that frozen point, under the tenant's `offlineMode` (G4-7). Lines
    record `clockState = unverified`. *Proposed, owner to ratify:* POS shows a non-blocking "clock not verified,
    scheduled price changes paused" indicator. `hwm_trusted` is also raised at every scan while `anchored`, so the
    freeze never un-activates a segment a scan already used. Under `online_only`, an `unverified` till must pass a
    fresh check before adding a line.
  - The next successful anchor resumes activation at true time.
  - **Clock incidents and findings are kept.** `ran_ahead` detection moves from the highest `t_lo` used (now always
    `hwm_trusted`) to the highest **wall-clock** reading seen during the episode, `wall_untrusted_max`. Each line also
    freezes `pricedAtUpper` (`t_hi` at capture). `sold_before_correction` judges `unverified` / `suspect` lines against
    that upper bound. When the wall clock runs slow or was rolled back, a server-certain bound (the incident's
    `anchoredAt`, or BC's receive time) raises `possible_sold_before_correction`. The offline-restart case is therefore
    reported, not hidden (design §4.2, §9.1, §9.3).
- **Consequence for the open question.** A store PC that restarts or wakes **offline** does not apply a scheduled price
  (for example a midnight change) until it reconnects. Until then it sells the price that was in effect at the last
  trusted instant. A device offline past a scheduled price **withdrawal** keeps selling the withdrawn price.
  This trade-off is the owner's to ratify. The alternative is the removed wall-time path, which the owner may accept
  only for a separately verified sale-capture need.

## G4-6 — Behaviour when time cannot be trusted

| Option | Content |
|---|---|
| **A (recommended)** | Three states. `anchored`: normal. `unverified`: activation by `max(hwm, wall)`; sales record it. `suspect` (wall below `hwm − 5 min`, or drift > 120 s with no resume event): **activation frozen at `hwm`** (no un-activation, no new activation) and pricing **treated as stale** in every mode, until a fresh anchor. |
| B | Block all selling while `suspect`. |
| C | Ignore suspicion and keep using the wall clock. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: matches RT-284 P-F ("a clock rollback counts as stale") and lets the tenant's mode decide whether stale blocks
(`deny_if_stale`) or only shows (`allow_cached`), instead of a second, clock-specific blocking rule.

**Owner disposition (2026-11-19, preliminary): approved, amended to follow G4-5.** In `unverified`, activation is frozen
at `hwm_trusted` instead of following `max(hwm, wall)`. That fail-safe treatment still needs owner ratification
(G4-5). `anchored` is unchanged, and so is `suspect`: activation frozen, and pricing treated as stale in every mode.

## G4-7 — Staleness definition and v1 defaults

| Option | Content |
|---|---|
| **A (recommended)** | `age = t_hi − lastCheckAt` where a **check** is a successful manifest read with the applied pair current (`If-None-Match` carries the applied pair's ETag, so a 304 counts; a failed apply does not). Defaults: `offlineMode = allow_cached`, `maxStaleness = 24 h`, `warnAfter = 12 h`, `poll = 300 s`, `onlineWindow = 360 s`. POS clamps `maxStaleness ≤ 72 h` and `onlineWindow ≥ poll + 60`; under `online_only` a lapsed window triggers one on-demand check at scan before refusing. `allow_cached` sells with a non-dismissable stale banner; `deny_if_stale` refuses new lines at a cached price; `online_only` requires a check within `onlineWindow`. |
| B | Same, default `deny_if_stale` with 24 h. Blocks a store's sales after one day of outage. |
| C | Age from the last *apply* rather than the last check. A store with no price changes would go stale while fully connected. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: RT-284 ratified `allow_cached` as the default for standard-tier offline behaviour; pilot connectivity is intermittent;
stale stays visible (625) and on every sale. A tenant that wants blocking sets `deny_if_stale`.

**Owner disposition (2026-11-19): approved as selected. Owner clarification c17659 is controlling and supersedes
c17655 and c17657.**

- **Defaults:** `offlineMode = allow_cached`, `warnAfter = 12 h` (43 200 s), `maxStaleness = 24 h` (86 400 s).
- **24 h is the default stale threshold, not a selling cut-off.** Past it, `allow_cached` **keeps selling** from the last
  correctly applied, valid projection. A persistent, non-dismissible stale banner shows on the sale screen and the
  receipt preview, and `stale = true` is recorded on each affected line and on the sale aggregate.
- **Still never sellable:** a product with no valid segment at `t_lo`, and a product that is inactive in the catalogue.
- **The 72 h clamp** is the POS upper bound on the *configured* `maxStaleness`. It is unchanged. It is neither the 24 h
  default nor a time at which `allow_cached` stops.
- **Stricter modes** remain a tenant choice. `deny_if_stale` refuses new lines once stale. `online_only` requires a live
  check.
- **Separate clocks:** pricing age counts from the last successful manifest check of the **applied** pair (a 304
  counts; a failed fetch or a failed apply does not). RT-284 policy-bundle age counts from bundle receipt. One is never
  substituted for the other.
- **RT-284 safety is not loosened:** sensitive capabilities stay `deny_if_stale`, critical capabilities stay
  `online_only` (RT-284 Q6), and a never-fetched sensitive or critical bundle fails closed (RT-284 Q10). Pricing
  `allow_cached` relaxes none of these.

## G4-8 — Where the freshness policy comes from before RT-284 ships

| Option | Content |
|---|---|
| **A (recommended)** | Interim tenant setting `pricing.offline` (Store override allowed), carried on the **pricing manifest** with `policySource` / `policyRevisionId` (spec 040 pattern). It moves to the RT-284 device policy bundle (PE-BC4 / PE-POS1) when that exists; the manifest field is then removed in a later contract version. |
| B | Wait for the RT-284 bundle. Blocks G4 implementation on RT-284. |
| C | POS constants only. Not configurable (contradicts 626). |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Note: RT-284 P-F rejected carrying policy on the **catalogue** read-down. The pricing manifest is a pricing surface carrying
only pricing freshness, and the interim is retired by design.

## G4-9 — Critical corrections

| Option | Content |
|---|---|
| **A (recommended)** | `critical = true` on an **emergency** Change Set (capability `pricing.emergency`), recorded on the revision. Effects: manifest `urgent` → online POS applies before the next scan; each segment produced by a critical revision carries `criticalRevision`, and before tender POS flags any open-cart line whose key's segment in effect now differs from the one it was priced from and is critical (covers corrections applied mid-cart and pre-delivered corrections crossing their `from` mid-cart); such lines need explicit old/new accept before tender (608). A line whose key has no segment in effect any more is flagged unsellable whatever the cause (this also covers critical withdrawals from skipped pairs) and must be removed explicitly; optional per-line `offlinePolicy {deny_if_stale | online_only, maxStaleness?, until}` (until required, default activation + 72 h, max 30 days) applies to those keys only; Health `critical_not_applied` per device; sync findings `sold_before_correction`, scoped to the corrected keys and each key's own activation instant. Pre-delivered bad prices are removed by superseding, never patched on the device. |
| B | A critical revision switches the whole Store to `online_only` until every device acks. Stops all sales at an offline till for one item. |
| C | No special handling beyond emergency publish. Fails 627. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: it gives both levers decision 627 names (shorter TTL, online-only) scoped to the corrected items, keeps 603/608/611,
and states plainly that an unreached offline device cannot be corrected, only detected; the tenant's `maxStaleness`
bounds that exposure. *(Superseded in part, 2026-11-19: under `allow_cached`, `maxStaleness` only marks the device stale
and does not stop selling (G4-7). Exposure is bounded only by a stricter tenant mode.)*

**Owner disposition (2026-11-19, preliminary): approved split.**

**In scope now:**
- the `critical = true` flag on an emergency Change Set. It is governed and audited, and it inherits spec 042's prior
  independent approval;
- manifest `urgent`, so an online POS applies the correction before its next scan;
- Health `critical_not_applied` per device;
- the sync finding `sold_before_correction`, scoped per key and per activation instant.

A critical revision never changes or erases the facts of a completed sale (611).

**Safety kept in scope:** a key with no valid segment at `t_lo` is unsellable. This includes a line already in an open
cart at tender: the line is flagged and must be removed explicitly. The rule applies whatever withdrew the price,
including a critical withdrawal carried by a pair the device skipped.

**Deferred.** Neither item is designed as shipped, nor part of the current contract or acceptance criteria:
- **per-line `offlinePolicy`** overrides, together with the segment fields that carry them;
- the **open-cart old/new acceptance** UI for a critical *price change*.

Until the old/new acceptance ships, a line already in the cart keeps its frozen price (603) when a critical revision
changes that key's price. Only a **withdrawn** price removes a line. Completed sales are never repriced.

**Stated limitation:** a device that never received the critical revision cannot be corrected while offline, and
`urgent` cannot reach it. The correction applies when the device reconnects. Exposure is reported through
`critical_not_applied` and `sold_before_correction`. It is bounded only when the tenant chooses `deny_if_stale` or
`online_only`; under `allow_cached`, `maxStaleness` only marks the device stale.

## G4-10 — Failed apply

| Option | Content |
|---|---|
| **A (recommended)** | Stage → verify `entryCount` + canonical `contentHash` → promote in **one** SQLite transaction. Any failure keeps the previous pair live and records `last_failed_pair`, a closed `failure_code` and time; ack `failed`; backoff 30 s → 5 min; after three failures on one pair, re-fetch from page 1. Before the first apply under `pricing` authority, nothing is sellable (`never_applied`). |
| B | Item-by-item apply with per-row retry. Contradicts 628. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.

## G4-11 — What the sale freezes (with PR-07)

| Option | Content |
|---|---|
| **A (recommended)** | Line: PR-07 provenance union verbatim, with `pricingRevision` = the **store revision the device applied** (the `asOfRevision` that reproduces its belief), plus a sibling **`pricingCapture {pricedAt, timeBasisEpoch, stale, clockState}`** frozen per line (these can change inside one open cart). Sale: an **aggregate** `pricingContext {appliedRevision (max), stale (any line), clockState (worst line), offlineMode, lastPricingCheckAt}`. |
| B | `pricingRevision` = the revision that published the event. Does not reproduce what the device saw when a later revision changed nothing for that key but did for others. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Consequence: PR-07 gains `pricingCapture` and `pricingContext` (additive). The union shape shared by PR-06 and PR-07 is unchanged.

## G4-12 — Sellability after cutover

| Option | Content |
|---|---|
| **A (recommended)** | Under `pricing` authority, POS sells an item iff the catalogue has it active **and** the applied projection has a segment containing `t_lo`. The catalogue snapshot includes active products without a current price, so future-only prices can be pre-delivered. |
| B | Keep the current-price sellable filter on the catalogue. A product launching at a future price can never be pre-delivered. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Interaction recorded for RT-485 (PR-16b): flip the filter and the manifest `authority` together. On the device the switch is staged: POS changes authority only after promoting a catalogue snapshot that carries the new `pricingAuthority`.

## G4-13 — Server revalidation of offline-priced sales

| Option | Content |
|---|---|
| **A (recommended)** | Asynchronous, never on the capture path. Recompute `resolve(item, store, pricedAt, pricingRevision)` with the zone of the line's `timeBasisEpoch`; findings `price_mismatch`, `sold_before_correction`, `early_activation` / `possible_early_activation` (from `ran_ahead` incidents matched to lines by `untrustedEpisode`, judged against the certain interval `[trustedFloor, anchoredAt]`, retroactively when needed, or a segment start later than BC's receive time), `device_clock_ahead`. A forward-clock sale with no such evidence is stated as undetectable. Findings go to Pricing Health; capture never fails; sale facts are never changed. |
| B | Reject sales whose prices do not revalidate. Contradicts 611 and loses real sales. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.

## G4-14 — Delivery cadence

| Option | Content |
|---|---|
| **A (recommended)** | A cheap manifest check (ETag/304) every `pollIntervalSeconds` (default 300) while online, plus at start, on reconnect and on manual refresh; snapshot only when the pair changes or `urgent`. The catalogue keeps its hourly cadence. |
| B | Reuse the hourly catalogue tick. Critical corrections could take an hour to reach an online till. |
| C | Server push (WebSocket / SSE). New infrastructure; not needed for v1. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.

---

## Evidence for OD-6 (not a new decision)

POS validates read-down responses with a hand-written check of required fields; extra fields are tolerated (POS
`read-down-client.ts:97-113,176-201`, no zod/ajv). The POS contract pin is checked by blob SHA
(`contracts/backend-core/PIN`), so every Backend-Core contract bump the POS adopts needs a POS re-pin in the same rollout.
This is input to OD-6 (RT-483), which keeps "assume strict until POS confirms".

## Open items for the owner

As of 2026-11-19 (RT-1492):

1. **G4-5 restart / resume fail-safe (blocking G4a).** Ratify the frozen-activation treatment of `unverified` described
   above (and in design §4.1–4.2), or name a verified sale-capture need for a bounded wall-time path instead.
2. **Interim treatment of a critical *price change* to a line already in an open cart (proposed, owner to ratify).**
   It keeps its frozen price (603) until the deferred old/new acceptance ships. Confirm, or ask for a stricter interim
   (for example, remove the line).
3. **The `sold_before_correction` / `possible_sold_before_correction` basis for untrusted lines (proposed, part of
   G4-5).** Upper bound `pricedAtUpper`, plus a server-certain bound, as described above.
4. **RT-279 gate for G4-3** (Needs verification): RT-279 must name the owner and the reviewed contract for store
   time-zone history.
5. **RT-280 Store Authority Lease:** no G4 decision references it, and no contract overlap was found in specs 041–043.
   Its applicability to offline pricing is still unproven. It is **not** treated as a blocker or as a waiver here.
