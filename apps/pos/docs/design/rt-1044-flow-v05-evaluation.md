# RT-1044: Flow V0.5 "Precision Workspace" evaluation (decision record)

| | |
|---|---|
| Jira | RT-1044 (Planning, To Do), parent RT-106 |
| Work Mode | Planning. Docs only: no production code, no contract change, no Jira status change |
| Baseline | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` @ `6e3ffc99a6dafc07193fd201f655ba1550768fe0` (checked 2026-11-03). The prototype's own audit used `3d576dc2`, which is older |
| Prototype source | RT-1044 attachment 10087 `retail-flow-claude-handoff (1).zip`. SHA-256 `6f7fcf1f04a1abea474f86764cdd3d38ac70271510d3fc7017df1111091fa893`, which matches the hash in the RT-1044 comment of 2026-11-01. The ZIP holds `prototype/retail-tower-flow-v05.html`, `evidence/retail-tower-flow-v05-ux-audit.md`, `evidence/retail-flow-v05-ux-audit-results.json` and 8 screenshots. The ZIP is not committed here. It is untrusted reference material |
| Decision IDs | This record's decisions are numbered **RT1044-OD-1..15**. Bare "OD-n" elsewhere refers to the existing owner decisions in [`DESIGN.md`](../DESIGN.md) and [`vnext/15-vnext-freeze-package.md`](vnext/15-vnext-freeze-package.md) (for example DESIGN.md OD-4 light only, OD-7 Direction B). RT-24 invariants: [`vnext/08-rt24-invariants.md`](vnext/08-rt24-invariants.md) |
| Status of this record | **Proposal for owner decision.** Nothing here is approved behaviour until the owner decides the OD list (section 10) on RT-1044 |

**How to read status words.** This record uses the words from the UX skill authority layer:

- **Governing:** an owner-approved rule.
- **Shipped:** on `main` and verified.
- **Merged, verification pending:** on `main`, but packaged verification is not recorded yet. RT-242 Direction B Sale layout, Undo and the void screen are in this state.
- **Target:** a Constitution direction not yet in code.
- **Open:** not decided.
- **Proposal:** this record's recommendation.

The comparison is **source-reviewed**: it is not measured. Neither the packaged POS nor a cashier was tested for this record (see section 2).

---

## 1. Verdict

**REVISE.** Keep Direction B (DESIGN.md OD-7, RT-242) as the base. Adapt a small number of V0.5 interaction ideas into it through separate, bounded slices. Do **not** adopt the prototype's layout, visual language, keyboard map, payment behaviour or toolbar.

V0.5's central idea is "Stable Core + Adaptive Context": a dominant live cart, and tools that appear only when they can act. That idea is compatible with the Constitution and largely **already describes Direction B**:

- the command bar with the scan owner;
- a cart-first work surface;
- the money column that never scrolls away;
- inline notices instead of dialogs.

Where V0.5 differs from Direction B, it mostly breaks a governing rule:

- the merged scan/search field;
- Enter that tenders;
- F-keys;
- a second accent and dark chrome;
- cashier-resolved card UNKNOWN;
- renderer-composed Undo;
- density and theme toggles during a sale.

Three ideas are worth carrying forward, each as an adaptation, plus one small marker (RT1044-OD-13):

1. **Selected-line context tools.** Quantity and remove for the focused line sit in one stable place.
2. **Inline unknown-barcode recovery** with a «البحث بالاسم» action.
3. **Fewer clicks into payment.** Today «تسليم السلة للدفع» and then «المتابعة إلى الدفع» are two presses. This one needs an owner decision because it touches the handoff step.

No prototype claim about cashier speed is accepted (RT-1044 planning scope item 4). Speed claims need the measurement slice (S0) first.

---

## 2. Evidence base and what was not done

| Item | Done? | Note |
|---|---|---|
| RT-1044 description, the 2 comments and the attachment | Yes | Attachment present (10087, added 2026-11-01 11:45). The 11:41 comment's "no attachment" blocker is resolved |
| Prototype HTML source read | Yes | Logic functions read: `submitSearch`, `pay`, `back`, `complete`, `resolve`, `clickAction`, `undo`, `newSale`, key handlers |
| Prototype screenshots viewed | Yes | `sale-1024`, `selected-1024`, `payment-1024`, `hold-1280`, `missing-1280` |
| Prototype audit (md + json) | Yes | Its findings F-01..F-09 are taken as reported and were not re-measured |
| POS `main` sale, catalogue, scan, checkout and recovery source | Yes | Files cited inline |
| `apps/pos/docs/DESIGN.md`, POS `CLAUDE.md` and the UX skill references (authority, POS, shared principles) | Yes | |
| Confluence UX-01..UX-13 pages re-read live | **No** | The rule IDs come from the ux-pos-console skill, recorded 2026-10-07..18, and DESIGN.md. A slice that implements any OD must re-read its modules |
| RT-24, RT-159, RT-242 and RT-1042 Jira issues read live | **No** | Their content is taken from DESIGN.md, `docs/design/vnext/` and the skill's amendments table |
| Packaged POS launched, or Direction B measured at 1024x768 and 1280x800 | **No** | Section 11's S0 is the slice that does this |
| Human or cashier timing | **No** | No throughput claim is made in either direction |

---

## 3. What V0.5 is, structurally

V0.5 is one standalone HTML page with simulated state. It has no persistence, IPC, money domain or devices.

- **Top bar** (dark green): brand, branch and cashier, a theme toggle, a simulated offline toggle, and «فاتورة جديدة».
- **Capture strip:** **one** field, «امسح الباركود أو اكتب اسم الصنف», with an `ENTER` hint. Beside it are demo buttons: quick add, a 23-line cart and a bad barcode.
- **Toolbar:** Undo (`Ctrl+Z` hint), «عرض مكثف» (a density toggle) and «تفريغ» (clear the cart).
- **"Live receipt":** a full-width line table with an index chip, the name, `SKU / barcode` meta, a quantity pill, the unit price and the line total. It shows the sale number `#00124` in its header.
- **Context lens:** an inline-end panel shown for payment, hold, a missing barcode, the selected item or ready. At 1024 the selected-item tools render as a dark tray between the cart and the dock.
- **Bottom dock** (dark, full width): the total with "items · units" on the inline start, and a lime «الدفع `F12`» on the inline end. During payment it becomes «رجوع للبيع».
- **Payment:** inline in the lens, with no route change. It offers cash or card. The cash field is `type=number`, pre-filled with the total, and **Enter confirms**. Card offers simulated success, decline or UNKNOWN. UNKNOWN goes to "HOLD / SAFE" with two cashier buttons, «تحقق: لم يُحصّل» and «تحقق: تم التحصيل».
- **Messages:** toasts in the corner, including error toasts.

---

## 4. Step-by-step comparison (same scenarios as RT-1044 scope item 2)

Current = `main` @ `6e3ffc99`. The Direction B Sale layout is merged with verification pending (RT-242 and RT-754 status as last recorded in the UX skill's authority layer and DESIGN.md; Jira not re-read live).

| # | Step | Current POS (source) | V0.5 (source and screenshots) | Assessment |
|---|---|---|---|---|
| 1 | Arrive on Sale | Focus goes to the scan owner (`LiveCatalogueRegion.tsx` `focusScanOwner()` on mount). The scan-owner state shows as text and an icon (`ScanStatus`) | Focus goes to the single field. The lens shows "QUIET BY DESIGN / جاهز للمنتج التالي" | Equivalent intent. V0.5 has no scan-owner state text, only a placeholder |
| 2 | Exact barcode scan | A wedge burst is a scan wherever focus is: gaps ≤35 ms ending in Enter (`scan/burst-detector.ts:15`, `scan-guard.ts`). The scan field's Enter calls `onScan`, then `lookupScan`, then main `catalogue.lookupBarcode`. That is an **exact** match, and only "exactly one distinct active product" adds (`product-repo.ts:8-22`, `useSaleCatalogueController.ts:112-125`). Direct add without a confirm (D-C1), a 150 ms row flash and «أُضيف: …» | Enter on the shared field runs `submitSearch()`: first an exact barcode, SKU **or full name** match; otherwise it **adds the first substring candidate** (`prototype:539`) | Current is safe. V0.5 adds on an exact name match and on a partial match, see F-01 |
| 3 | 10 repeated scans of the same code | Each adds +1 to the existing line in queued order (`useDirectSaleAdd.ts` "each add sends quantity 1, so a merge is exactly +1"). Focus stays on the scan owner | +1 per Enter in the renderer state | Equivalent. In current, main persists each add (by design; restart survival not runtime-verified here) |
| 4 | Partial barcode (`622010000010`) | Through the scanner, exact lookup (normalised equality) returns `not_found` for a strict prefix that is not itself a registered barcode, and the inline M-S3 notice shows. A prefix that is registered as a shorter barcode correctly adds that product. Through the search field, Enter runs a typed search that shows a **results list**. `applySearchResponse` has no auto-add branch (`useSaleCatalogueController.ts:27-43`), so adding needs an explicit pick. A burst into the search field is treated as a scan and clears it (`scan-fields.ts:53`) | Adds the first matching product (audit F-01: total 286.00 -> 406.00) | **Current: zero partial auto-add by construction.** Missing test: an unregistered strict prefix of a real barcode through `lookupBarcode` returns `not_found` (named as a guard test in S1) |
| 5 | Unknown barcode | An inline one-line notice (M-S3) in the command bar. Scanning continues and no modal opens | A popover over the cart: «الباركود مش موجود», the code chip, «البحث بالاسم» and «تجاهل». **A red toast** also appears | Adapt the «البحث بالاسم» action into M-S3. Reject the toast and the colloquial copy |
| 6 | Typed name search | A separate search field («البحث بالاسم أو الباركود»), 150 ms debounce, minimum 2 characters. The dropdown shows 3–5 results over the cart, and Esc returns to the scan owner. A pick adds and closes | The same field as the scanner, with suggestions. Up/Down moves the highlight. Enter adds the highlighted candidate | Current keeps scan and search semantics apart (freeze 15 §3). V0.5 merges them: **reject** |
| 7 | Select a line and edit its quantity | The cart region is a tab stop; Up/Down move between rows and keep the same row control (`useCartRowFocus.ts:42`, Arrow keys only); row controls stay in the Tab order (`:9-10`). The 44 px +/−/حذف row buttons are the only way to edit. The RT-24 `+/-` and Delete row keys (I-4) are **not built** on `main` (wave 1 is keyless, D-K1). RT-855 already tracks a **selected line** for «خصم» (`LiveSaleWorkspace.tsx:130-140`) | Click or Enter on a row opens tools: «زيادة 1», «تقليل 1» and «حذف الصنف» in the lens, or a dark tray at 1024. After Enter, focus drops to `BODY` (F-04) | Adapt the "tools for the selected line" idea onto the RT-855 selected line. Fix the focus loss |
| 8 | Undo | «تراجع» for the last add or delete only. Main proves eligibility (`cart.undoLast`, D-U1). It is unavailable after handoff and is not recreated after a restart. DESIGN.md records D-U1 as shipped in #621 and owner-ratified 2026-10-20; this record keeps "merged, verification pending" because RT-242 packaged verification is not recorded | A renderer snapshot of the whole state restores rows, the selection and the issue. It also undoes «تفريغ» | **Reject** the renderer inverse (UX-05.21; POS rule "never compose the inverse in the renderer") |
| 9 | Remove a line | Delete on the focused row, Undo offered, focus moves to the neighbour row (`useRemovalFocus.ts`) | «حذف الصنف» in the lens or tray | Equivalent intent |
| 10 | Manual discount | «خصم» on the selected line. Every positive discount is manager-only, through RT-114 approval for a cashier (`DiscountControl`, `DiscountApprovalDialog`) | None | V0.5 has no discount. Any adopted line-tools surface must host the existing «خصم» entry |
| 11 | 23-line cart at 1024x768 | Target ≥6 rows visible (DESIGN.md Layout). Compact rows are 52 px. `FitGuard` covers the 600–767 px band. **Not measured on the packaged build** | 3 full rows at 1024 and 4 at 1280 (audit F-02). The selected tray costs about 80 px more | V0.5 fails the target. Current needs S0 to prove it |
| 12 | Park a sale | «تعليق» (Park v1, pilot-mandatory; up to 5, same operator) and «المبيعات المعلّقة» | None. "Hold" in V0.5 means a **payment** hold | Naming collision: «معلّقة» is already the park word. Do not reuse it for payment UNKNOWN |
| 13 | New sale while the cart has lines | Not offered on Sale. On Completion it is «بيع جديد». Void is the cancel path, and a frozen cart needs a manager | «فاتورة جديدة» in the top bar at any time, with an inline confirm that clears the cart | **Reject.** The confirm makes the loss explicit, not silent, so the reason is the journey rule: a new sale is defined only on Completion, and a cart with lines leaves the Sale only through Park (keeps it) or Void (manager rule when frozen). A confirm-and-discard bypasses both |
| 14 | Go to payment | Two presses: «تسليم السلة للدفع» freezes the cart in main (`frozen_handed_off`), then «المتابعة إلى الدفع» mounts the frozen envelope and routes to `/app/checkout` (`LiveSaleCart.tsx:334-372`, `useSaleCartController.ts:561-568`) | One press: «الدفع» (or `F12`) switches the screen to payment with no freeze | RT1044-OD-6. Fewer presses are a real gain. The freeze must stay a main-confirmed step |
| 15 | Back to the sale | RT-26 Back/Esc to the **same** draft, only while main says `returnable`. Back is disabled with a reason once money is recorded or a tender panel is open (`PaymentSurface.tsx:111-205`) | «رجوع للبيع» is always allowed in payment | V0.5 lacks the eligibility rule. Any inline-payment variant must keep it |
| 16 | Cash entry | Cash keypad and `QuickAmounts`: Exact **fills** the amount, and chips **set** it, never add (I-9). Money is integer minor units. Bursts into money fields are rejected (M-S5). The cash limit applies (M-P29). **Enter never tenders** (I-4) | `type=number` field (float), **pre-filled with the total**, and **Enter confirms** (`prototype:463`, `:563`). The confirm button is 43 px at 1024 | **Reject** (F-10, critical) |
| 17 | Change due | Computed once and shown until completion (S9) | Recomputed live in the renderer from the float | Current |
| 18 | Card success or known decline | Card is **post-pilot** (RT536-D4; the pilot is cash only). S10/S11 are defined in the freeze | Simulated success, and decline with «المحاولة مرفوضة … يمكن اختيار وسيلة أخرى» | Out of pilot scope |
| 19 | Card UNKNOWN | Target S12: danger tone, «النتيجة غير مؤكدة», primary «متابعة إجراء الاستعادة», which blocks a new charge, Back and sign-out. **The card UNKNOWN UI is not on `main`**: the copy exists only in returns (`returns-messages.ts:75`), and the payment UNKNOWN classification (D-P1, RT-116) is Open. On `main` (merged; packaged verification not checked here): the cash path's "cancel outcome unknown" danger line (M-P18, `RecoveryPanel.tsx`) and the stuck-payment recovery screen (`v5/recovery/`) | "HOLD / SAFE" with danger copy «لا تكرر الدفع قبل التأكد», and **cashier buttons that declare the outcome**. «لم يُحصّل» returns to tender | **Reject** the cashier self-resolution (section 7.3) |
| 20 | Completion and receipt | `CompletionPanel` and `ProofList`: only proven facts, a receipt **sent** to the printer or failed, sync pending or done. «بيع جديد» gets focus | "TRANSACTION COMPLETE" in an all-caps English eyebrow and «اكتملت المحاكاة». No proof list | Current |
| 21 | Offline and sync | A real signal only (VN-S6). The sale stays local in `sale_sync_outbox` and syncs from main. Offline copy is defined | A cosmetic toggle, «اتصال · تجريبي» | Reject the toggle (UX-07.4) |
| 22 | Shift | Advisory banner (M-W1/S20). The sale is not blocked | None | No V0.5 input |
| 23 | Lock | The lock screen hides the sale. PIN focus. The scanner is blocked | None | No V0.5 input |

---

## 5. Prototype defects: classification

F-01..F-09 come from the prototype audit. F-10..F-19 are additional findings from reading the prototype source and screenshots for this record.

| ID | Severity | Defect | Guarded on `main` by | Required if the pattern is adopted |
|---|---|---|---|---|
| F-01 | Blocker | A partial barcode, or an exact **name**, auto-adds through the shared field | Separate scan field. Exact `lookupBarcode` in main. Typed search has no auto-add branch. Burst routing | Keep the two fields (RT1044-OD-2). S1 adds guard tests: a prefix of a real barcode returns `not_found`, and search Enter never adds |
| F-02 | Major | 3 rows at 1024 and 4 at 1280 | DESIGN.md target of ≥6 rows. `FitGuard` | S0 measures. S2 compacts the chrome only if S0 shows a shortfall |
| F-03 | Major | 9 of 18 controls under 44 px; cash confirm 43 px | DESIGN.md 44 px floor; commit 56/60 px | Every adopted control is ≥44x44 px |
| F-04 | Major | Row Enter drops focus to `BODY` | `useCartRowFocus` keeps row context on ↑/↓; focus returns to the scan owner after an add | The S3 line tools must keep row focus, and Esc must return focus to the row and then to the scan owner |
| F-05 | Major | Density toggle mid-sale | Profiles follow the workspace container (width, and compact under 768 px high), never a user toggle mid-sale | Reject the toggle (RT1044-OD-11) |
| F-06 | Major | 10 px meta and headings | Twelve-Pixel Rule | All adopted text ≥12 px (11 px for kbd chips only) |
| F-07 | Major | Icon-only buttons with no accessible name; English `aria-label` («Open item quantity controls») | UX-03 icon rule; One-Locale Rule | Arabic accessible names on everything |
| F-08 | Major | Dark theme and simulated offline toggles | DESIGN.md OD-4 (light only); UX-07.4 | Reject (RT1044-OD-11) |
| F-09 | Blocker | Float money, fake payment success | Integer minor units; main decides transitions (I-1) | Copy no logic from the prototype |
| F-10 | Blocker | The cash field is pre-filled with the total and **Enter confirms the tender** (`prototype:463`, `:563`). A single Enter completes the sale. The field has no burst guard | I-4 (Enter never tenders), I-9 (Exact only fills), M-S5/UX-08.17 (bursts refused in money fields) | Reject (RT1044-OD-8) |
| F-11 | Blocker | The cashier declares the card UNKNOWN outcome («تحقق: تم التحصيل» / «لم يُحصّل»). "Not collected" re-opens tender | S12 and UX-05.25: recovery only. D-P1 and RT-116 are Open. Card is post-pilot | Reject (RT1044-OD-9) |
| F-12 | Blocker | Undo is a renderer state snapshot. «تفريغ» clears the whole cart and can be undone | D-U1 / `cart.undoLast`: main proves eligibility for the last add or delete only (UX-05.21) | Reject (RT1044-OD-11). Clear-cart with Undo would need a new main contract (section 9) |
| F-13 | Blocker | «فاتورة جديدة» during an active sale clears the cart after a confirm | New sale exists only on Completion (freeze 15 §1 journey); a cart with lines leaves only through Park or Void. The inline confirm makes the loss explicit, but it bypasses both paths | Reject (RT1044-OD-11) |
| F-14 | Major | `/`, `F12`, `Ctrl+Z` and `ENTER` key hints (and `F8` as a test-harness key) | D-K1: wave 1 is keyless and no hint shows for an unbound key | Reject (RT1044-OD-10) |
| F-15 | Major | Dark green chrome, a lime commit (a second accent), a corner glow on the dock | UX-02: Mineral Daylight + Tower Teal; No-Second-Accent; No-Gradient; Commit-Teal. The v3.5 dark command rail is superseded | Reject (RT1044-OD-12) |
| F-16 | Major | All-caps Latin labels ("CAPTURE / 01", "RECEIPT / LIVE", "HOLD / SAFE", "TRANSACTION COMPLETE", "FLOW / NO SYNC / NO REAL PAYMENT") | One-Locale Rule; Plain Emphasis Rule (UX-12, UX-03) | Reject |
| F-17 | Major | Colloquial Egyptian copy («مش موجود», «هتُمسح», «تقدر», «اختار») | UX-12.4-.5: concise MSA or commonly understood retail Arabic | Rewrite through the message catalogue |
| F-18 | Major | Error toasts. The unknown barcode shows as a red toast on top of the inline notice | DESIGN.md: a toast is neutral and only for user-initiated, non-financial acknowledgements. UX-11.20: do not stack messages | Inline notice only |
| F-19 | Major | A sale number (`#00124`) in the cart header during an editing sale | D-N1 (sale-number display) is Open | Do not show it |

---

## 6. Constitution check (V0.5 as drawn, per module)

**Pass** = V0.5 is consistent with the rule. **Risk** = consistent only after the fixes named. **Conflict** = V0.5 contradicts a governing rule.

| Rule | Subject | V0.5 | Why |
|---|---|---|---|
| RT-24 I-1 | Main decides transitions | **Conflict** | Payment, Undo and new sale are decided in the renderer |
| RT-24 I-4 | Enter never tenders | **Conflict** | F-10 |
| RT-24 I-9 | Exact fills and chips set | **Conflict** | Pre-filled amount, then an Enter commit |
| RT-24 I-12 | Back only to the same draft | **Conflict** | Back is always allowed in payment |
| Freeze 15 §1 journey | New sale only on Completion; Park or Void otherwise | **Conflict** | «فاتورة جديدة» clears a cart mid-sale (after a confirm) |
| D-C1 | Direct add, no confirm dialog | Pass | Direct add |
| D-K1 | Wave 1 keyless | **Conflict** | F-14 |
| D-U1 / UX-05.21 | Undo only with a restoring domain contract | **Conflict** | F-12 |
| D-N1 | Sale-number display (Open) | **Conflict** | F-19 resolves an Open item by design |
| RT536-D4 | Pilot is cash only | Risk | Card flows are drawn as if in scope |
| UX-01 Product Personality | Calm, precise; anti-patterns (glow, spectacle, novel patterns without measured benefit) | Risk | The "precision" character fits, but the glow, dark chrome and merged field are novel patterns with no measured benefit (UX-01.27-.33) |
| UX-02 Colour and Visual Identity | Mineral Daylight + Tower Teal, light-first, no second accent, no gradients | **Conflict** | F-15, F-08 |
| UX-03 Typography and Iconography | 12 px floor, text decides, no all-caps, money in the UI sans with tabular figures | **Conflict** | F-06, F-16, icon-only top buttons (F-07). Money uses tabular figures, which passes |
| UX-04 Layout, Density, Spatial | ≥6 rows at 1024, never scrolled away, density not user-chosen mid-sale, compress space before meaning | **Conflict** | F-02 and F-05. The total is pinned in the dock, which passes. The money column moves from the inline end to a bottom dock, which breaks "same place through the journey" (DESIGN.md Layout) |
| UX-05 Interaction Language | Smallest safe commitment surface, one primary per region, hide unauthorised and explain blocked, recovery only for UNKNOWN | Risk / Conflict | Inline context tools pass UX-05.3. The F-11 self-resolution conflicts with UX-05.25. «تفريغ» and new sale add destructive actions next to frequent ones |
| UX-06 Motion | 80/150/220 ms, no ambient motion, reduced motion | Risk | Not measurable from the screenshots. The dock glow is decoration. A reduced-motion path is not shown |
| UX-07 Operational States | Do not invent truth, toasts are neutral, proof before celebration, Pending ≠ Failed ≠ UNKNOWN | **Conflict** | Simulated offline (F-08), error toasts (F-18). The completion panel has no proof stack. The UNKNOWN wording itself passes: it is never called «مرفوض» |
| UX-08 Forms, Input, Validation | Money parsed and never guessed; machine input never in money fields | **Conflict** | F-10: a float `type=number` field with no burst guard |
| UX-09 Navigation and IA | A workflow is one place; POS navigates tasks | Pass / Risk | Inline payment keeps one place (a possible gain). Back eligibility is missing |
| UX-10 Tables and dense lists | Aligned columns, tabular figures, one scroll owner | Pass / Risk | The receipt table is aligned and has one scroll owner. Its 10 px column headings fail UX-03 |
| UX-11 Accessibility and RTL | 44 px, focus, forced colours, accessible names, no stacked alerts | **Conflict** | F-03, F-04, F-07, F-18. Forced colours untested |
| UX-12 Content and Localization | MSA retail register, one locale, money format `1,250.00 EGP` | **Conflict** | F-16, F-17. Money shows as `318.00` with a separate `EGP` and no grouping test |
| UX-13 Data visualisation | Not applicable | — | No charts |

---

## 7. Effects on speed, offline and payment UNKNOWN

### 7.1 Scanner and keyboard speed

- **Scanning.** Today's path is already zero-step: a burst anywhere becomes a scan and adds directly (D-C1). V0.5 adds no step here, and it removes none. Its merged field only adds risk: F-01, and a cashier who types a name then scans gets the scan appended to the typed text in the same field. **Net: no gain, real risk.**
- **Line edits.** V0.5's tray gives one obvious place for +1, −1 and remove. Current puts 44 px +/−/حذف buttons on every row: a keyboard user reaches them with ↑/↓ then Tab, and there are no row-edit keys. **A possible gain** for pointer, touch and keyboard users if the tools keep row focus (F-04). Measure it in S3 against S0's numbers (clicks or keystrokes per edit, time to the next scan). Do not assume it.
- **Into payment.** V0.5 needs 1 press, current needs 2. **A real gain of one press per sale**, subject to RT1044-OD-6. The F12 shortcut is out (D-K1).
- **Cash.** V0.5's pre-fill plus Enter is the fastest path because it is the unsafe one (F-10). Current Exact fills the amount, then a 56 px commit. **No speed change is acceptable here.**

### 7.2 Offline and outbox

V0.5 has no persistence. No recommended adaptation changes the existing bridge contracts, their payloads, main persistence (`sale_sync_outbox`, the cart and payment tables) or the sync engine. S3 and S5 call existing `cart.*` operations through the typed preload bridge unchanged. S1 adds tests only (some on the main side), with no production change. The offline indicator stays the real-signal design (VN-S6), and the simulated toggle is rejected. **Effect of the adopted items on offline behaviour: none**, provided each implementation slice changes only the renderer and calls only the existing bridge (`cart.*`, `catalogue.*`, `payment.*`); S1 is tests only.

### 7.3 Payment UNKNOWN

V0.5 gets three things right:

- it treats UNKNOWN as distinct from a decline;
- it blocks retry, new sale and edits while unresolved;
- it uses danger tone with the message "do not pay again".

All three already exist as target S12.

It gets the **resolution** wrong. A cashier button that declares «تم التحصيل» or «لم يُحصّل» turns an unproven external fact into a recorded outcome. «لم يُحصّل» then offers tender again, which can cause a second charge. That breaks RT-24 core rules 2 and 3 and UX-05.25. Resolving UNKNOWN belongs to the payment and recovery contract (D-P1, RT-116; manager recovery with dual attribution and terminal-void confirmation). D-P1 and RT-116 are Open, and card is post-pilot.

**Recommendation:** reject. The pilot (cash only) has no card UNKNOWN surface to redesign. The cash-path M-P18 line and the stuck-payment recovery screen on `main` stay as they are.

---

## 8. What must not change

Any slice that comes out of this record must keep all of these unchanged:

1. **Scan ownership.** One visible scan owner. Burst detection by timing (≤35 ms + Enter). Exact barcode lookup in main. Typed search never auto-adds. Bursts are refused in money, PIN and card-reference fields. Scanning is suspended in dialogs.
2. **Main decides** cart, handoff, payment, Undo eligibility, Back eligibility and completion (I-1). The renderer displays and requests.
3. **Handoff freeze** (`frozen_handed_off`) before payment, and RT-26 Back eligibility from main.
4. **Cash rules.** Enter never tenders. Exact fills and chips set. Integer minor units. The cash limit applies (M-P29). Change is computed once. Duplicate-submit prevention.
5. **UNKNOWN is recovery only.** It is never «مرفوض», never offers another tender or Back, and the cashier never self-resolves it.
6. **Undo** is `cart.undoLast` only: the last add or delete, proven by main.
7. **No new keys or key hints** (D-K1).
8. **Light theme only.** Mineral Daylight + Tower Teal tokens. One teal primary per region. No second accent, no gradients.
9. **The money column** stays on the inline end and in the same place from Sale through Checkout to Completion. The total and the commit never scroll away at 1024 or 1280.
10. **Density** follows the workspace container (width, and compact height under 768 px; RT-312 D12, RT-407), never a user toggle mid-sale.
11. **Floors.** 44 px targets; 56/60 px commit; 12 px text (11 px kbd chips only).
12. **Copy** comes from the message catalogue, in MSA retail register, one locale.
13. **Completion** shows the proof list and only proven facts. Receipt "sent", never "printed", without proof.
14. **Offline, sync and outbox** behaviour and indicators come from real signals only.
15. **Discount** stays manager-only through RT-114. Park v1 behaviour. The void credential rules.
16. **Nothing in `docs/design/rt-1042/`** or the sign-in screens (RT-1042 is separate).

---

## 9. Gaps where a V0.5 idea would need a backend or contract change

None of the **recommended** adaptations (S1–S4) needs a Backend-Core, OpenAPI or migration change. The V0.5 ideas below would. They are listed so the owner sees the cost of adopting them as drawn.

| V0.5 idea | Contract it needs | Owner of the contract |
|---|---|---|
| Clear the whole cart, with Undo | A main cart action covering multi-line clear and its restoring inverse, plus `cart_action_outbox` lineage. `cart.undoLast` covers only the last add or delete | POS main (RT-24 / RT-245 Undo eligibility) |
| SKU and barcode under each cart line | The main cart contract `CartSnapshotLine` (`src/shared/cart/bridge-types.ts:269-278`) carries only `line_id`, `display_name`, `quantity`, `unit_price_minor`, `line_subtotal_minor`, `note` and `version`; the renderer `CartLineItem` (`useSaleCartController.ts:18-26`) mirrors it. Showing a SKU or barcode needs the `cart.lines` snapshot to carry it | POS main cart contract; data from the Backend-Core catalogue snapshot, which already has the fields |
| Card UNKNOWN verify or resolve | A terminal status-query contract and a resolution authority (who may declare the outcome, with what evidence) | D-P1 / RT-116 payment and recovery contract (Open, post-pilot) |
| One-press «الدفع» | **Probably no contract change**: the renderer can run the existing `cart.handoff`, then mount on main's confirmation. Because it changes when the freeze is triggered, RT-24's handoff semantics must be re-read and the owner must confirm | Owner decision (RT1044-OD-6); RT-24 |
| Inline payment on the Sale screen (no `/app/checkout` route) | No backend change. It moves RT-26 Back eligibility and the `PaymentSurface` state into a Sale-screen panel. This is a large renderer restructure, and RT-754 (Sale -> Checkout verification) is still open | Owner decision (RT1044-OD-7) |
| A user density preference | Q-1 (UX-04 density modes) is Open; a preference would need a persisted setting | Owner decision; UX-04 slice |
| Sale number in the cart header | D-N1 is Open | Owner decision D-N1 |
| Real offline indicator | VN-S6 (already planned; not a V0.5 gap) | VN-S6 |

---

## 10. Owner decisions (OD list)

Each item has one recommendation: **Adopt**, **Adapt** (use the idea inside Direction B and the Constitution) or **Reject**.

| OD | Area | Recommendation | Reason |
|---|---|---|---|
| RT1044-OD-1 | Overall direction | **Adapt.** Verdict REVISE: Direction B stays the base; V0.5 contributes RT1044-OD-4, RT1044-OD-5, RT1044-OD-13 (the «آخر مسح» marker) and possibly RT1044-OD-6 only | V0.5's core idea is Direction B's. Its deltas mostly break governing rules (section 6) |
| RT1044-OD-2 | One shared scan + search field | **Reject** | F-01 (partial and name auto-add); freeze 15 §3 scan ownership |
| RT1044-OD-3 | Layout: full-width receipt and a bottom money dock | **Reject the dock.** Keep the inline-end money column. Adapt only "less chrome above the cart", if S0 shows fewer than 6 rows | DESIGN.md: the money column stays in the same place through the journey; F-02 |
| RT1044-OD-4 | Contextual tools for the selected line (quantity, remove, and the existing «خصم») | **Adapt** (slice S3): attach to the RT-855 selected line; keep row focus (F-04); ≥44 px; no tray that costs cart rows at 1024 | A possible pointer and touch gain; matches UX-05.3 |
| RT1044-OD-5 | Inline unknown-barcode recovery with «البحث بالاسم» | **Adapt** (slice S4): extend the M-S3 inline notice in the command bar with an action that focuses the search field. No popover over the cart, no toast, MSA copy | Keeps scanning uninterrupted and gives one next step (UX-07.26) |
| RT1044-OD-6 | One press into payment (instead of «تسليم السلة للدفع» then «المتابعة إلى الدفع») | **Adapt, gated** (slice S5): one «الدفع» that runs the existing handoff and continues only on main's confirmation. Any failure stays on the same draft with the reason. Start only after RT-754 packaged verification and an RT-24 handoff re-read. No key binding | One press saved per sale, with no semantic change if done this way |
| RT1044-OD-7 | Payment inline on the Sale screen instead of the `/app/checkout` route | **Reject for the pilot.** Revisit after RT-754 with measured evidence | A large restructure of verified-pending code. Direction B already keeps the money column in place. RT-26 Back eligibility must move with it |
| RT1044-OD-8 | Cash amount pre-filled with the total; Enter confirms | **Reject** | F-10; I-4, I-9, UX-08.17 |
| RT1044-OD-9 | Card decline and UNKNOWN UI with cashier "verify" buttons | **Reject** | F-11; card is post-pilot; D-P1 and RT-116 are Open |
| RT1044-OD-10 | Keys and hints `/`, `F12`, `Ctrl+Z`, `ENTER` | **Reject now.** Any wish for a key goes through the D-K1 process (bench test the scanner prefix and suffix, conflict tests, a visible button alternative) | D-K1 |
| RT1044-OD-11 | Toolbar: «تفريغ» with Undo, «فاتورة جديدة» mid-sale, density toggle, dark toggle, simulated offline toggle, demo buttons | **Reject all** | F-05, F-08, F-12, F-13; I-12; Q-1; DESIGN.md OD-4 (dark deferred); UX-07.4 |
| RT1044-OD-12 | Visual language: dark green chrome and dock, lime commit, glow, all-caps Latin eyebrows | **Reject.** Keep Mineral Daylight + Tower Teal | F-15, F-16; UX-02, UX-03, UX-12 |
| RT1044-OD-13 | Line metadata: index chip, `SKU / barcode` line, «آخر مسح» marker | **Adapt the «آخر مسح» marker only** (12 px, text plus the existing row flash). **Reject** the SKU/barcode line for now: it needs a cart projection change (section 9) and costs row height at 1024 | UX-04 "compress space before meaning" |
| RT1044-OD-14 | Copy register | **Reject the colloquial copy.** All new strings go through the message catalogue in MSA retail register | F-17; UX-12.4-.5 |
| RT1044-OD-15 | Measure before adopting | **Adopt** (slice S0): a Verification issue measuring Direction B on the packaged app before any S2–S5 work | There is no proven baseline for rows, target sizes or focus at 1024 and 1280; RT-1044 forbids speed claims from prototype tests |

The RT1044-OD-4 and RT1044-OD-5 adaptations are Proposals. The owner may also reject them; Direction B then stays as is.

---

## 11. Proposed Implementation issue split

These are proposals only. No Jira issue is created by this record (RT-1044: "do not implement or create child implementation tickets without approval"). Each needs its own Definition of Ready.

| Slice | Work Mode | Depends on | Scope | Evidence required |
|---|---|---|---|---|
| **S0** Direction B packaged baseline | Verification | RT1044-OD-15 | Packaged Windows build at 1024x768 and 1280x800, 100% and 125% scaling: the 23-line cart row count, every control's size, the focus path for scan, search, row edit, Undo and Back, forced colours, reduced motion, 10 repeated scans, a partial barcode, an unknown barcode | Captures, a measurement table and a pass/fail list against DESIGN.md. No fixes in this slice; defects are reported |
| **S1** Scan and search guard tests | Implementation (tests only) | none | Main: a strict prefix of a seeded barcode that is **not itself registered** as any barcode (assert that in the fixture) through `lookupBarcode` returns `not_found`; a prefix that is itself a registered shorter barcode correctly returns that product. Renderer: search-field Enter never adds a line; a burst into the search field is a scan; a burst into the cash field is refused (add each only where no test exists today) | Tests pass on CI |
| **S2** Chrome compaction for ≥6 rows at 1024 | Implementation | S0 shows a shortfall | Reduce command-bar and status chrome only. No change to money, commit, row height, target sizes or text size | Before and after captures at 1024 and 1280, light and forced colours |
| **S3** Selected-line tools | Implementation | RT1044-OD-4, RT1044-OD-13, S0 | Quantity, remove and «خصم» for the RT-855 selected line in one stable place. If RT1044-OD-13 is approved, the 12 px «آخر مسح» marker on the last-added row. Row focus kept. Esc returns focus to the row, then the scan owner | Keyboard-only walkthrough; keystrokes per edit and time to the next scan against S0; axe; 44 px audit |
| **S4** Unknown-barcode recovery action | Implementation | RT1044-OD-5, S0 | Add «البحث بالاسم» to the M-S3 inline notice, which moves focus to the search field. Catalogue copy | Unit tests; capture; screen-reader announcement check |
| **S5** One-press «الدفع» | Implementation | RT1044-OD-6, S0, RT-754 verified, RT-24 re-read | One commit runs the existing `cart.handoff` and continues on main's confirmation. A pre-handoff refusal stays on the editable draft with the reason. If handoff succeeded but the mount or navigation fails, the cart is frozen: show the existing frozen state with «المتابعة إلى الدفع», and return to editing only through `cart.returnToSale` when main's `returnToSaleEligibility` allows it. Once tender activity exists, only the existing payment or recovery paths apply. No key binding | Tests for success, pre-handoff refusal, post-handoff mount or navigation failure, payment already in flight, and double press; packaged walkthrough; no change to the Back eligibility tests |

Measurable acceptance for any adopted slice, from the RT-1044 test matrix:

- 0 wrong items over 10 repeated exact scans, partial codes and ambiguous codes.
- Focus never lands on `BODY`.
- ≥6 cart rows at 1024 with 23 lines.
- Every control ≥44x44 px and the commit at 56/60 px.
- All text ≥12 px.
- The total and the commit are visible at 1024 and 1280.
- Forced colours and reduced motion pass.
- No new key bindings.
- No change to any `cart.*`, `payment.*` or `catalogue.*` bridge call.

---

## 12. Open items and next safe action

- **Needs verification:** every statement about current runtime layout (rows, sizes, focus) until S0 runs. Direction B is merged with verification pending, not Shipped.
- **Doc inconsistency noted, not fixed:** DESIGN.md Layout says "today's shipped Sale is still the Direction A V5 layout", while the code on `main` renders the Direction B command bar (`LiveProductRail.tsx:69-75`). A docs pass should reconcile it.
- **Still Open, not resolved here:** D-K1 key map, D-N1 sale number, D-P1 card outcome, Q-1 density modes, RT-262 font.

**Next safe action:** the owner decides RT1044-OD-1..RT1044-OD-15 on RT-1044. If RT1044-OD-15 is accepted, open S0 as a Verification issue first.
