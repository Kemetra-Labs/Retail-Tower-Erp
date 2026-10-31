# RT-1027: the open-shift screen, centred, in EGP, with the full commit (evidence)

UX-04 (impeccable critique, 2026-10-31). With no shift open, the G-2 opening column was a small card in the inline-start corner, the float field had no unit and the commit was a 44px button. This slice amends the G-2 reference ([README row](../../README.md)); the frozen pack in [`G2-Shift/`](../../visual-acceptance/G2-Shift/G2-Spec.html) is not redrawn.

## The change

- **Centred.** `.v5-shift-state--open` (only the no-shift branch of `V5ShiftRoute`) grows to the work area and centres its column (`align-content: safe center; justify-items: center`). The unavailable and bridge-missing states keep `.v5-shift-state` as it was.
- **Unit.** The float label reads «مبلغ الافتتاح في الدرج (EGP)», `EGP` in an LTR run, as M-P16 (`CashEntry`) does. `ShiftAmountField` takes an optional `unit`; only the opening float passes it. The close count, pay-in / pay-out and forced-close fields are unchanged. `SHIFT_COPY` is unchanged.
- **Commit.** «فتح الوردية» adds `.v5-btn--commit` (56px, full width) and stays the primary.

## Captures

`rt1027-{before,after}-<State>-<W>x<H>[-forced].png`, from `#/dev/shift-proof?state=<State>`, before on `main` 8696ba18 and after on this branch. States: Open and ClosedApproved (outcome notice plus card).

Every open-shift state (Open, OpenInvalid, Closed, ClosedApproved, plus Opened and Unavailable after) was checked at 1024×768 and 1280×800, light and forced colours ([before log](rt1027-before-log.json), [after log](rt1027-after-log.json)):

| Check | Before | After |
|---|---|---|
| Card offset from the section's inline edges (1024 / 1280) | 452 + 16 / 700 + 24 px | 234 + 234 / 362 + 362 px |
| Commit height × width | 44 × 94 px | 56 × 446 px |
| axe-core (light) | 0 violations | 0 violations |
| Section scrolls / horizontal overflow | none | none |
| Text under 12px / control under 44×44 | none | none |

## Rerun

From `apps/pos`, start Vite (`npx vite --port 5291 --strictPort`), then run the command in the header of [`tools/capture-rt1027.cjs`](tools/capture-rt1027.cjs).
