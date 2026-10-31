# RT-1023: slim-rail status labels, captures

Owner decision 2026-10-31 ("Short label under glyph"). In the slim rail, each status row shows
its glyph over a one-word 12px label: «الاتصال», «المزامنة», «المعلّقة», «الطابعة» (doc 15 M-O5).
The label is `aria-hidden`. The full state text stays in the accessibility tree, and the
connection row is still the only live region.

## What was captured

- **Source:** the DEV harness `#/dev/status-proof` with the real AppRouter and V5 frame, as the
  manager (the most nav links, so the tightest footer).
- **Screens:** the live sale (`/app/cart`) and the dashboard (`/app/dashboard`). Both use the slim
  rail.
- **Sizes and modes:** 1024×768 and 1280×800, light and forced colours.
- `before/`: baseline `origin/main` 8696ba18, before any change. Five states: Connected,
  Checking, Offline, Attention and PrinterFailed. That is 40 PNGs, with
  `before-capture-log.json`.
- `after/`: the same states plus `AllRows`. `AllRows` is a new harness state with connection,
  sync attention, a held sale and the failed printer, the tallest footer. That is 48 PNGs, with
  `after-capture-log.json`.

## Checks (every capture, in the logs)

| Check | Before | After |
|---|---|---|
| axe violations (light) | 0 | 0 |
| Footer in view, inside the rail, rail does not scroll, no horizontal overflow | pass | pass |
| Text under 12px in the footer | 0 | 0 |
| Short label shown under each row's glyph | none (glyphs only) | every row, 12px |
| Label clipped or outside its row | n/a | none |
| Printer row height | 44px | 44px |

## Re-run

From `apps/pos`, with `npm run dev:vite` running:

```bash
CHROMIUM="C:/Program Files/Google/Chrome/Application/chrome.exe" node docs/design/vnext/captures/RT-1023/tools/capture-rt1023.cjs docs/design/vnext/captures/RT-1023/after after
```

`STATES=<comma list>` limits which states run. Without `CHROMIUM`, the script uses Playwright's
own browser.

The script exits non-zero and prints each failing capture when any check fails. The baseline has
no labels, so for a `before` run, set `EXPECT_LABELS=0`.
