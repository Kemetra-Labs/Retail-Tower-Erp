---
name: driving-electron-via-cdp
description: Use when screenshotting, smoke-testing, or visually reviewing the POS-Pulse Electron app (or any dev Electron app) without the owner at the keyboard, or when a UI review shows "the old UI", a narrow/clipped layout, zero products, or keys that do not reach React handlers.
---

# Driving Electron via CDP

## Overview
Drive dev Electron through the Chrome DevTools Protocol with Node 22's global `WebSocket`. No puppeteer is needed. Most "UI bugs" seen this way are review-tool artifacts, so run the preflight before any visual verdict.

## Launch (POS-Pulse)
1. Reuse the running Vite (5173). Build preload with `npx vite build --config vite.config.preload.ts` and main with `npx tsc -p tsconfig.main.json`.
2. Run `electron . --remote-debugging-port=9333 --user-data-dir=<scratch>/ud`.
   - **Always use a scratch `--user-data-dir` from the first launch.** The DB lives in userData. Never touch the owner's `%APPDATA%\pos-pulse`.
   - **Give it as an 8.3 short path** (`cmd /c for %I in ("<dir>") do @echo %~sI`). Chromium silently ignores an over-long path and falls back to `%APPDATA%\pos-pulse`, running migrations on the owner's real DB; a session scratchpad path is long enough to trigger this.
   - **Before any interaction**, confirm the scratch dir gained `pos-pulse.db` and the owner's `%APPDATA%\pos-pulse` files did not change.
   - The dev catalogue seed is skipped if ANY tenant has products. A fresh profile fixes "0 products".
3. Env flags as needed: `POS_PULSE_DEV_SKIP_PAIRING`, `…_OPERATOR_SIGNIN`, `…_SEED_CATALOGUE`, `FEATURE_CART`, `PRODUCT_SEARCH`, `PAYMENTS` = `1`.
4. Wait for the role-landing redirect to settle before navigating (for example `#/v5/sale`).
5. Git Bash rewrites `/app`-style args, so prefix `MSYS_NO_PATHCONV=1`.

## Visual preflight (all four before any verdict)
| Check | Why |
|---|---|
| `innerWidth` ≥ 1024 | Docked DevTools shrinks the page to about 1015px, which triggers the narrow fallback (nav hidden). Close it via `GET http://127.0.0.1:<port>/json/close/<id>`. |
| DevTools target closed | SendKeys Ctrl+Shift+I is unreliable. |
| DPI-aware capture | PowerShell `CopyFromScreen` at 125% crops the right side, which looks like clipping. Use CDP `Page.captureScreenshot` + `Emulation.setDeviceMetricsOverride`, or `SetProcessDPIAware()`. |
| Seeded data present | See the seed note above. |
Resize with `Browser.setWindowBounds`. Below 1024px, "Screen too small" is correct behaviour.

## Input via `Runtime.evaluate` / `Input.*`
- React inputs: use the native value setter + a dispatched `input` event.
- Enter: `Input.dispatchKeyEvent` `type:'keyDown'`, `text:'\r'`, then `keyUp`. `rawKeyDown` + `char` does NOT reach `onKeyDown`.
- axe-core: inject via `Runtime.evaluate({expression: axeSource})`. An inline `<script>` is blocked by CSP.
- Probe one key event and one lookup in isolation before a long capture script.

## Reading state
- DB: `ELECTRON_RUN_AS_NODE=1 electron db.cjs` with better-sqlite3 `readonly`.
- When cloning catalogue rows into a scratch DB, override the normalized columns too (`barcode_norm`), or lookups hit the source row.

## Claims to avoid
- A source-substring CSS test is a tripwire, not cascade verification. Name it that.
- `vi.stubEnv('DEV', false)` does not reach `import.meta.env?.DEV`. Prove DEV-only routes are absent via `npm run build` + a grep of `dist/renderer/assets`, with a positive control.
- Settled UI state held in a component's local `phase` is not settled domain state. Check the store and main-process guards.
