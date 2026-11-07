# POS rules (Electron cashier app, Direction B)

Behaviour authority: RT-24 and later contracts (POS `docs/design/vnext/08-rt24-invariants.md`, I-1..I-17). A slice must cite the invariants it preserves. The renderer **displays and requests; main/local storage decides transitions** (I-1).

## Pilot scope and supported display

- Pilot: Windows Electron, **cash only** (card post-pilot, RT536-D4); returns manager-only, online-only, cash payout; voucher disabled (I-11); no split tender.
- Display (RT-312): pilot 1920x1080 @100%; width <1024 blocked; height <600 blocked; 600-767 compact band (RT-407); never auto-zoom; page zoom locked; native menu bar removed. Compact layout also triggers on height under 768px. Copy for blocked screens: M-F2/M-F3.
- Must-see elements at 1024x768 and 1280x800 with banners and a 20-30 line cart: amount due/total, commit, cancel/back, change, scanner state. At least 6 cart rows at 1024.

## Journey (freeze section 1)

Sale (`/app/cart`) -> Checkout (`/app/checkout`) -> Completion -> «بيع جديد». UNKNOWN goes to Recovery and never repeats a sale. A workflow is one place, not many nav destinations (UX-09.2). Cashier lands on Sale after sign-in/unlock. Back/Esc from Checkout returns to the **same** draft only while no funds are applied and nothing external is in flight or ambiguous (I-12, RT-26); Back and Confirm cannot both succeed.

## Scan ownership, focus, keys (freeze section 3)

1. Exactly one scan owner (`ScanTarget`); its state is always visible with text plus icon.
2. A wedge burst is a scan wherever focus is: gaps <=35 ms ending in Enter (default, tune on pilot scanner; no minimum length). It never activates the focused control.
3. Money fields, PIN fields and the card reference **reject** bursts with the field-specific inline notice (M-S5) and keep their previous value. Search owns typing; a burst there is treated as a scan and clears the field. Dialogs suspend scanning visibly and refuse bursts with M-S6; a completed sale shows M-S7.
4. Default focus: Sale -> scan owner; Checkout -> first enabled tender tile; cash entry -> amount field; Dialog -> the **safe** option; Lock -> PIN; Completion -> «بيع جديد». Focus returns to the scan owner after add, undo, Back from Checkout, new sale. A dialog close returns to its invoker. Row `+/-` keep row context; `Delete` (with undo) moves to the neighbour row.
5. Keys frozen for wave 1: Esc, Enter, Tab, Up/Down, Delete, +/-. **Enter never tenders** (I-4); no key-repeat on money; `Delete` and `+/-` act only with a cart row focused; every key has a visible button alternative. No F-keys, no keycaps except Esc on Back (D-K1). **The whole RT-24 proposed map is deferred, modifier combinations included**: F1, F2, F3, F4, F6, F8, F9, Ctrl+Enter, Ctrl+N, Ctrl+P, Ctrl+Shift+L. None is bound, `Ctrl+Enter` too. Freeze 15 §3.3: Enter activates only the focused control and never tenders on its own; in a money field it does not apply the tender. **Doc tension to surface, not settle:** the cash commit (`cash-entry-confirm`) is a native button, so a keyboard Enter on it while focused applies cash. Ask the owner whether that counts as "tendering" before designing Enter behaviour on financial buttons. To propose a key, raise an owner decision first: bench-test the scanner prefix/suffix, test conflicts with Electron, Windows and the Arabic layout, and keep a visible button alternative (I-4). Relevant controls: `CashEntry` with `QuickAmounts` (Exact and set-amount chips) and, on Completion, «بيع جديد». A new-sale action on Checkout is not defined anywhere and would risk dropping a valid cart (I-12); do not invent one.
6. One cart tab stop; rows by Up/Down. Pointer clicks return focus to the scan owner after the action; targets 44px+. Action slots are stable: inline-end = primary/commit, inline-start = cancel/back; a destructive action never occupies the commit's previous slot.

## Direct add and Undo

Resolved scan or picked search result adds immediately (or +1 on the existing line), row flashes 150 ms (none under reduced motion), scrolls into view, last-scan line «أُضيف: الاسم». No confirm dialog (D-C1). Undo «تراجع» for the last add or delete is **merged** (D-U1, RT-242 PR #621, `cart.undoLast`; RT-242 stays In Review until packaged verification): main proves eligibility by last-action identity; Undo is unavailable after handoff; any later cart mutation invalidates it; do not recreate it after restart; on `undo_not_available` show quiet copy («لم يعد التراجع متاحًا.») and refresh the cart. Never compose the inverse in the renderer.

## State matrix (freeze section 2; behaviour status as recorded, re-check Jira)

S1 empty cart; S2 active/long cart; S3 unknown barcode (M-S3, keep scanning); S4 flagged item (display only, e.g. «بوصفة طبية», no blocking, I-17); S5 discount (**every positive manual discount is manager-only**, I-6); S6 held sale; S7 checkout before tender; S8 cash entry/shortfall (commit blocked with reason «المبلغ أقل من المستحق»); S9 change due (computed once, shown until completion); S10 card waiting (cancel carries the terminal-void warning); S11 card declined (known decline: choose another method); **S12 UNKNOWN (primary «متابعة إجراء الاستعادة»; blocks new charge, Back, sign-out; danger, never «مرفوض»)**; S13 finalizing / failed (retry only after SETTLED); S14 completion (proof list); S15 offline; S16 syncing; S17 manager approval; S18 locked; S19 live tender after restart; S20 shift advisory; S21 session expired; S22 storage blocked (blocks collecting money).

**Known decline vs UNKNOWN**: after a *proven* decline (S11/M-P8) the cart is intact and another tender may be offered. While the external charge is UNKNOWN or unresolved, offer recovery only: never another payment, Back or sign-out (S12, M-P9, M-P13, UX-05.25). A terminal **timeout or lost response is not proof of a decline**: treat it as unresolved (UNKNOWN, S12) until a proven outcome arrives. The exact trigger classification belongs to the payment/recovery contract (D-P1, RT-116) and is still open, so say that instead of inventing a mapping. Card is post-pilot (cash only), so review card-flow changes against S10-S12 and flag that they sit ahead of the pilot scope.

## Cash and money rules

- **Exact fills the amount only; quick-amount buttons set the received amount, they do not add** (I-9). Change = received - due, computed once and shown until completion. Integer minor units; duplicate-submit prevention; no tender by scanner Enter.
- Cash limit: amounts above max(EGP 100,000, balance owed) are refused as probable scanner digits (M-P29, D-F2). Shift fields: opening float/pay-in above EGP 100,000.00 or counted cash above 1,000,000.00 refused (M-W5, RT-278; verify status). Pay-out has no cap. Never "try again" on these.
- Pilot tax line stays «قيد الإضافة · لا تُحسب هنا» (VAT deferred); no VAT amounts, QR, fiscal or ZATCA/SAR content (I-17). Check Fiscal & Tax pages before changing.

## Completion and receipt

Completion is read-only with no edit affordance (I-5). The proof list shows only proven facts: payment, sale number (only if proven, D-N1), receipt **sent** to printer / failed, sync pending/done. Never «طُبع» without proof. Receipt failure after a completed sale is a warning that keeps the sale proven (UX-07 stress test, M-C3); offer reprint or manual receipt. Cashier may reprint the last receipt and see «المبيعات» history (RT536-D1, RT-534): duplicates only with original immutable facts; older/incomplete records print a labelled **sale record**; voided = «ملغي» marked record only; every detail open and reprint is audited.

## Session, lock, held cart, stuck payment (RT-116)

- Inactivity lock at 600 000 ms; lock never discards cart or tender and never reverses tender on any session end. Lock screen shows **nothing of the sale** (lines and amounts hidden; L3, RT-161); PIN focus; scanner blocked; M-L1. Locked sessions refuse every operation except unlock/sign-in guards (`session_locked`).
- Cashier PIN unlock works offline; manager unlock is an online re-auth (interim).
- Held cart and stuck attempt re-attach only to the owner; another operator is refused when live tender exists (`terminal_has_unresolved_payment`, generic, non-disclosing). Sign-out is refused while the session owns a started attempt with live tender (`payment_in_progress`).
- Manager recovery (RT-114-gated): dual attribution; cancel requires explicit confirmation that cash was returned / card voided on terminal.
- Park/Resume v1 (pilot-mandatory, RT536-D2): same operator, editing carts only, at most 5 per terminal, revalidated on resume, durable save before clearing, no implicit stock reservation. Held-sale UI states depend on RT-158/spec 024; do not ship behaviour ahead of its contract.

## Manager approvals and credentials (Authority Matrix; verify per action)

- RT-114 approvals (manual discount, post-handoff cart cancel, pay-in/out, variance acceptance, cashier PIN unlock) use a terminal-enrolled **manager approval PIN**, bound to action + amount/cart version + reason, dual attribution (requester + approver), offline-capable within validity. Never a bare manager ID.
- Void of a finalized sale: manager credential per RT-495 (password) vs RT-530 screen (PIN confirm): open tension, see authority reference.
- Returns: online-only, manager/admin signed in, cashier refused, pilot cash payout; hidden from cashier nav.
- Unauthorized actions are hidden; temporarily blocked ones show the reason (UX-05.14).

## Shift and cash (Shift & Cash architecture, RT-17 V1)

- Expected cash = opening float + cash sales - cash refund payouts + pay-in - pay-out; change is never subtracted twice. Only settled physical-cash effects count.
- **First closing count is blind**: expected cash is hidden from cashiers until the first count is submitted; recount = new immutable attempt; manager approval never changes variance to zero; Accepted/Reviewed never means Matched; negative expected cash is a Cash Integrity Exception, never clamped or normal-closed; forced close never fabricates a count; pay-in/out need structured reason codes.
- The pilot design calls shift advisory (banner M-W1/S20), but with `POS_PULSE_FEATURE_SHIFT_CASHUP` on, main refuses cash apply and settlement when no shift is open on the terminal (`shift_not_open`; RT-998, RT-276 c14719); with the flag off, cash is allowed without a shift. Opening float is an explicit operator-confirmed fact. Cash session != login session; lock, restart, time do not end it.
- Cash drawer is optional: never require it, never show the drawer-not-opened notice; non-sale drawer opens are auditable and may require a reason by policy.

## Offline and sync

Connectivity and sync indicators come only from real signals (VN-S6 plan; never hard-coded). Offline copy: «غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.» Syncing stays pending/info until the queue drains; health returns quietly. Offline cashier admission is a sealed terminal-bound grant (RT-113); manager offline sessions stay denied. Network-dependent capabilities (returns, store-wide history) are disabled with the reason; offline history is labelled partial.

## Pharmacy domain limits (I-17)

Unit/pack/batch/expiry only where contracts allow. **No** prescription workflow, insurance, therapeutic substitution or compliance claims. A flag badge is display-only.

## Things a POS design must not decide

Lazy cart, key map, held-sale behaviour ahead of RT-158, manager approval auth mechanics ahead of RT-114, card decline contract (D-P1), sale-number display (D-N1), anything in "still open" in the authority reference.
