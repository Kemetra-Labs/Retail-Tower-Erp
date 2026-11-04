# RT-1166 (RT-1044 S0): Direction B Sale screen baseline

Work Mode: Verification. Nothing here fixes a defect; each failure names its first failing
boundary. Source: [`rt-1044-flow-v05-evaluation.md`](../../../rt-1044-flow-v05-evaluation.md) §11 S0 and
§8; owner decisions RT1044-OD-1..15 (RT-1044 comment 15252, accepted 2026-11-03).

**Status of this record: the unpackaged half is measured; the packaged Sale rows are NOT RUN.**
They need the owner (a pairing code, the sign-in, and 23 cart lines) and the lab values. What the
packaged exe did give: the ≤819×614 CSS `ScreenTooSmall` capture. Every "R-pkg" cell below that
says NOT RUN is open, not passed.

## Evidence labels

| Label | What it is | What it is not |
|---|---|---|
| **R-dev** | The unpackaged `electron .` build of `main` `cc0a2e409` (the same SHA as the packaged artifact below), renderer served by Vite from source, scratch `--user-data-dir`, dev fixtures (`POS_PULSE_DEV_SKIP_PAIRING`, `_SKIP_OPERATOR_SIGNIN`, `_SEED_CATALOGUE`), a local stub that answers only the health probe. Measured and captured over CDP: `Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot`, `getBoundingClientRect`, `Input.dispatchKeyEvent`. Forced colours and reduced motion are CDP `Emulation.setEmulatedMedia`. | Not the packaged exe, not a Windows contrast theme, not rt9 data. The cart is a **fixture** of 23 distinct products (the 11 active dev-seed products plus 12 fixture products added to the scratch DB only). Signed in as the dev fixture manager. |
| **R-pkg** | The CI artifact `pos-pulse-win-unpacked-cc0a2e40…` (run 41823711583), `POS Pulse.exe` sha256 `df8b0ad9…faa7f9e7`, `resources/app.asar` sha256 `ee8146e9…c5852bf0021b`. Captured with Win32 `PrintWindow` on the client area, window sized with `SetWindowPos`. No input is sent by the agent. | Not CDP (the packaged exe refuses it by design). |
| **Owner** | A person at the device. | Blocked on the owner. |

## How the two scales are read (this changes the answer)

The laptop is natively at Windows 125 %. A CDP DPR override keeps the **CSS viewport** fixed, so a
"125 %" row at the same CSS size is identical to the 100 % row by construction and proves nothing
new. What a cashier on a 125 % screen gets is a smaller CSS viewport. Both readings are shown and
labelled:

- **(a) CSS size held constant**: 1024×768 and 1280×800 CSS at DPR 1 and DPR 1.25. Layout is
  identical; the DPR 1.25 captures only show that it renders at that scale. Not an independent pass.
- **(b) Physical screen held constant**: a 1280×800 screen at 125 % is **1024×640 CSS**, and a
  1024×768 screen at 125 % is **819×614 CSS**.

## State matrix (the dev chrome changes the row count)

Rows visible depend on what sits above the cart. The R-dev window had a stub backend, so the
states below were produced one at a time and recorded per capture. A paired rt9 terminal with a
downloaded catalogue loses at least the «لم يُنزّل الكتالوج بعد» chip, which was showing in **every**
R-dev capture, so the packaged pass matters for rows beyond "same bundle".

| State | What shows above the cart |
|---|---|
| clean | nothing (printer notice dismissed with «لاحقًا», online) |
| printer | the info banner «لم تُختر طابعة الإيصالات بعد…» (62 px), online |
| offline + printer | the warning banner «غير متصل — البيع محفوظ…» plus the printer banner |
| **+ chip** (the «أُضيف: …» text stays on screen; only the «تراجع» button expires after about 8 s, and the data field `state.chipVisible` is true even when idle, so rely on `commandH`) | any of the above, within 8 s of an add, while the «أُضيف: … · تراجع» chip is showing |

## Measurement table (23 lines; fully visible rows only, a partly cut row is not counted)

Rows fully visible in the cart scroller, `cartTop` in CSS px from the viewport top, row height in
brackets. Source: `data/measure-*.json`.

| CSS viewport | clean | clean + chip | printer | printer + chip | offline + printer | offline + printer + chip |
|---|---|---|---|---|---|---|
| **1024×768** (compact, row 52) | **10** (176.5) | **9** (228.5) | **9** (246.1) | **8** (298.1) | **8** (292.7) | **7** (344.7) |
| **1280×800** (comfortable, row 60) | **9** (184.5) | **9** (184.5) | **8** (258.1) | **8** (258.1) | **7** (304.7) | **7** (304.7) |
| **1024×640** = a 1280×800 screen at 125 % (b) | **8** (176.5) | **7** (228.5) | **6** (246.1) | **5** (298.1) | **5** (292.7) | **4** (344.7) |
| **819×614** = a 1024×768 screen at 125 % (b) | `ScreenTooSmall` («الشاشة أصغر من 1024×768») | | | | | |
| 1024×768 and 1280×800 at DPR 1.25, (a) | identical to the DPR 1 row of the same size | | | | | |
| R-pkg, Sale, any size | NOT RUN (needs the owner) | | | | | |

The layout jump on an add is real and is finding F5: at 1024 the status row wraps to a second line
while the chip shows (measured in the printer-banner state, cartTop 246.1 → 298.1), so the cart moves down 52 px for about 8 s after every add (command bar 115.7 →
167.7 px; `data/chip-layout-shift.json`; capture `scan-chip-visible-1024x768.webp`). At 1280 it does
not move. It may depend on the dev-only catalogue chip; the packaged pass decides.

Forced colours (emulated) and reduced motion do not change any number in the table (no separate capture for the reduced-motion numbers beyond `scan-motion-reduced`). Verified for
**clean** at 1024×768 and 1280×800, DPR 1 and 1.25.

## Control sizes (R-dev, clean, DPR 1; `data/measure-idle-clean.json`)

Every interactive control and tab stop, in CSS px (w × h). Source rule in brackets.

| Region | Control | 1024×768 | 1280×800 |
|---|---|---|---|
| Command bar | scan field (input) | 319.2 × 44 | 441.6 × 44 |
| | search field (input) | 204 × 44 | 285.6 × 44 |
| | «المبيعات المعلّقة» | 157.4 × 44 | 157.4 × 44 |
| | «تحديث الكتالوج» | 116.4 × 44 | 116.4 × 44 |
| | «تراجع» chip button | 55.2 × 44 | 55.2 × 44 |
| Cart | «خصم» | 88 × 44 | 88 × 44 |
| | row «إنقاص» / «زيادة» / «حذف» (92 controls over 23 lines, minimum) | 44 × 44 | 44 × 44 |
| | row «ملاحظة» | 50 × 44 | 50 × 44 |
| Money column | **«تسليم السلة للدفع» (commit)** | **254.4 × 56** | **286.4 × 56** |
| | «تعليق البيع», «إلغاء البيع» | 118.7 × 44 | 134.7 × 44 |
| | grand total block | 254.4 × 76 | 286.4 × 85 |
| Rail | five route links | 67.2 × 56 | 67.2 × 56 |
| | printer, sign-out | 67.2 × 44 | 67.2 × 44 |
| Banner (printer state) | «اختيار الطابعة», «لاحقًا» | 106.3 × 44, 58.8 × 44 | same |

Money column: 280 px wide at 1024, 320 px at 1280 (inline end). Command bar 115.7 px high idle,
167.7 px with the chip at 1024.

**Text minimum:** 11 px, only on the Rx and controlled-substance flags (`.v5-live-flag`). Every
other visible text node is ≥ 12 px. With no flag on screen the minimum is 12 px.

## Scans (R-dev, simulated wedge bursts at ~4 ms; `data/scans.json`)

| Test | Result |
|---|---|
| 10 repeated exact scans of one code (22.00 EGP) | One line 1 → 11, total 683.00 → 903.00 EGP (+220.00 = 10 × 22.00), 23 lines before and after. **0 wrong items.** Focus on the scan owner. |
| Partial barcode, 12, 11 and 10 digits (strict prefixes of registered codes) | Cart unchanged, inline notice «الباركود … غير موجود في الكتالوج. امسح مرة أخرى أو ابحث بالاسم.» (captures `scan-partial_a/b/c`). **0 wrong items.** |
| Unknown barcode (13 digits) | Cart unchanged, the same notice, no modal (it renders as a floating pill over the search field and status row, see `scan-unknown`). Scanning continues, focus on the scan owner (`scan-unknown`). |
| A prefix typed into the **search** field + Enter | Cart unchanged: «لم يُعثر على الصنف». No add. |
| A name search («ام») | Results list opens; nothing is added until a pick. |

## Focus path (R-dev, keyboard events over CDP; `data/focus-path-*.json`)

| Step | Where focus lands |
|---|---|
| Arrive on Sale from the rail | scan field |
| Scan add (burst) | scan field |
| Search: type 2+ chars, **3 Tab stops** (park, catalogue refresh, then the results listbox), ArrowDown, Enter | pick adds the line; focus returns to the scan field |
| Search: Esc with results open | scan field |
| Cart region (Tab stop 6 from the scan field), ArrowDown | moves between rows (`LI`) |
| Row edit: Enter on «زيادة» | the same «زيادة» button, quantity 2 → 3 |
| Row remove: Enter on «حذف» of the last row | «حذف» of the neighbour row |
| Undo: «تراجع عن حذف …» is Tab stop 2 from the scan field, Enter | scan field; the line is back (22 → 23) |
| **Handoff: Enter on «تسليم السلة للدفع»** | **`BODY`** (F1) |
| Continue «المتابعة إلى الدفع», Enter | Checkout, first tender tile «نقدي» |
| Back: Esc on Checkout | Sale, scan field; handoff button editable again, cart intact |

Keyboard cost with 23 lines: the four row controls per line are Tab stops, so **98 Tab presses**
from the scan field to «تسليم السلة للدفع» (92 row stops). This is the baseline S3 is measured against.

Focus rings: «المبيعات المعلّقة» and the commit draw a solid teal outline (measured; the row buttons were not measured separately); in emulated
forced colours the outline colour becomes the system colour (the scan and search fields show the
ring on their wrapper, visible in `idle-clean-forced-*`). Reduced motion: the 150 ms
`v5-row-flash` animation runs after a scan in normal and forced-colours modes and is absent under
reduced motion (`data/focus-ring-and-motion.json`).

## Pass / fail against the §11 bar (R-dev; R-pkg NOT RUN)

S0 acceptance is **partial**: it asks for the packaged build at 100 % and 125 %; only the `ScreenTooSmall` screen was captured packaged.

| # | Criterion | Result | Note |
|---|---|---|---|
| 1 | ≥ 6 rows at 1024 with 23 lines | **PASS (R-dev) at 1024×768** in every state (10 down to 7). **Open at 1024×640** (reading b): 5 or 4 rows in three of the six states | The DESIGN.md bar is "at 1024×768"; whether it covers the 600–767 high band is the owner's call (see S2 below) |
| 2 | Every control ≥ 44 × 44 | **PASS (R-dev)** | Smallest: row «إنقاص», «زيادة», «حذف» 44 × 44; «تراجع» 55.2 × 44 |
| 3 | Commit 56 / 60 px | **PASS at 56; DESIGN.md "60 at comfortable" NOT met on Sale** | 56 at both 1024 and 1280. The Sale rule `.v5-live-sale .v5-sale-checkout.v5-btn { min-block-size: 56px }` (`live-sale.css:460-464`) has no comfortable lift; the Checkout ledger lifts to 60 (`checkout.css:823-827`) |
| 4 | Text ≥ 12 px | **FAIL** | 11 px Rx / controlled flags, `.v5-live-flag` `font-size: var(--font-size-2xs)` (`live-sale.css:186-190`) |
| 5 | Total and commit visible at 1024 and 1280 | **PASS (R-dev)** | In the viewport in every state and size, including 1024×640 (the money column is pinned) |
| 6 | Focus never on `BODY` | **FAIL (one step)** | F1 |
| 7 | 0 wrong items over the scans | **PASS (R-dev)** | 10 exact, 3 partial, 1 unknown, 1 typed prefix |
| – | Forced colours, reduced motion | **PASS** (emulated) | Layout unchanged; flash removed under reduced motion. A real Windows contrast theme is an owner check |

## Findings (not fixed; first failing boundary)

- **F1. Focus drops to `BODY` after the handoff.** Enter on «تسليم السلة للدفع» swaps the money
  column's action from `HandoffAction` to the frozen-cart «المتابعة إلى الدفع» button (a different
  element, `LiveSaleCart.tsx:351-364`), and focus is not moved. Reproduced twice (`document.activeElement` is `BODY` at +100 ms, +400 ms and +1500 ms; raw readings in `data/focus-path-3.json`;
  `focus-after-handoff-body.webp` shows the frozen cart, a still image cannot show `BODY`). A keyboard or scanner-only cashier loses their place; the next
  Tab starts from the document start. Fails the `BODY` criterion and the F-04 class in the
  evaluation record. Slice: S5 touches this button (RT-1171); a focus fix belongs there or in its own issue.
- **F2. Rx and controlled-substance flags are 11 px.** `live-sale.css:186-190`. A cashier must read
  them, so the Twelve-Pixel Rule applies (11 px is for key-hint chips only).
- **F3. Rx and controlled-substance flags disappear from existing cart lines after an app
  restart (and a renderer reload).** After a full restart the 23 lines come back with 0 flag
  elements; a fresh scan of the same product shows them. The flags are the add-time renderer store
  `stores/line-flags-store` (RT-242 M-S9, `LiveSaleWorkspace.tsx:225`), not part of the persisted cart snapshot. Out of S0 scope and
  safety-adjacent: report as its own issue. Not investigated further here.
- **F4. Sale commit is 56 px at the comfortable density** (criterion 3 above).
- **F5. Layout shift at 1024 on every add.** See the state-matrix note. Hand to S2's decision,
  after the packaged pass shows whether it happens with a real catalogue chip.
- **Observation.** Search-result dropdown shows more than the 3–5 results DESIGN.md names (six or
  more for a two-letter query). Not measured against the bar, listed for S4.
- **Capture note (tool, not POS).** `Page.captureScreenshot` hangs on the Checkout and
  `ScreenTooSmall` screens in the unfocused dev window; `captureBeyondViewport: true` works for the latter.

## S2 (RT-1168, chrome compaction): is it needed?

The answer depends on one thing only the owner can state: **does the "≥ 6 rows at 1024" bar apply
to a 1024×640 CSS viewport** (a 1280×800 laptop at real 125 % scaling, which is the compact-height
band 600–767 px)?

- **If the bar is 1024×768 only:** no shortfall in any R-dev state (10 to 7 rows). S2 is not
  needed on R-dev evidence; this is unconfirmed until a packaged pass exists (not run).
- **If the bar also covers 1024×640:** a shortfall appears with the printer banner plus the chip
  (5), with the offline banner (5 and 4), and in no state without a banner. S2 is needed on R-dev
  evidence, and it would be the banner stack and the chip's wrap, not the cart rows.
- **Plain answer:** read literally ("≥ 6 rows at 1024 with 23 lines, at 100 % and 125 %"), 5 rows
  at a real 125 % on a 1280×800 screen **is a shortfall** whenever a banner shows. Recommendation:
  RT-1168 is needed, bounded to banner and chip chrome, with the packaged pass still outstanding. The owner decides.
- A third, independent reading: **1024×768 screens at 125 % get `ScreenTooSmall`** (819×614 CSS,
  captured on the packaged exe too). That is a product-limit question, not an S2 question.

This record does not choose. Both outcomes go to the owner on RT-1166.

## Not run

- R-pkg Sale rows at any size, scale and state, and the focus path and scans on the packaged exe.
  Needs: the rt9 launch values, a pairing code and manager sign-in typed by the owner, and 23
  distinct lines added by the owner (a scanner, or a catalogue of ≥ 23 active products on rt9).
- Windows High Contrast and real display scaling variants beyond this laptop's native 125 %.
- A real scanner (timing) and a screen reader.

## Captures

`captures/dev/` (R-dev), `captures/pkg/` (R-pkg). Names are `<state>-<mode>-<w>x<h>-<scale>.webp`
(state `idle-clean`, `chip-clean`, `idle-printer`, `chip-printer`, `idle-offline-printer`,
`chip-offline-printer`; mode `light` or `forced`; a `-125` suffix is DPR 1.25 and, for 1024×640,
the physical 1280×800 at 125 %). Plus `scan-*` (notices, motion, the chip shift),
`toosmall-819x614-125.webp` and `focus-after-handoff-body.webp`. No capture shows a code, PIN,
host or id: they hold fixture products only. Raw measurements: `data/`.

## Method notes (for the runbook)

- Dev window unfocused: `Input.dispatchKeyEvent` is dropped unless
  `Emulation.setFocusEmulationEnabled { enabled: true }` is set. `setDeviceMetricsOverride` is per
  CDP connection and must be re-applied on every connect.
- The 23-line fixture: the dev seed has 12 products (11 active); 12 more were inserted into the
  scratch DB only, and the cart was built with 23 simulated scans.
- The stub backend answers only `GET /api/v1/health/live` with 200. Any 5xx from another route
  flips the terminal to "degraded", so unknown routes return 404.
