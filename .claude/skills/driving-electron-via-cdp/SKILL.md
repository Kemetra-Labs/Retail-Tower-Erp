---
name: driving-electron-via-cdp
description: Use when screenshotting, smoke-testing, or visually reviewing the POS-Pulse Electron app (or any dev Electron app) without the owner at the keyboard, or when a UI review shows "the old UI", a narrow/clipped layout, zero products, or keys that do not reach React handlers.
---

# Driving Electron via CDP

## Overview
Drive dev Electron through the Chrome DevTools Protocol with Node 22's global `WebSocket`. No puppeteer is needed. Most "UI bugs" seen this way are review-tool artifacts, so run the preflight before any visual verdict.

## Launch (POS-Pulse)
1. Work from `apps/pos` (the configs and `dist/` below are relative to it). Reuse the running Vite (5173). Build preload with `npx vite build --config vite.config.preload.ts` and main with `npx tsc -p tsconfig.main.json`, then delete `dist/build-identity.json` (as `dev-electron.cjs` does, RT-719) so the session reports an unknown build, not a stale commit.
2. Run `npx --no-install electron . --remote-debugging-port=9333 --user-data-dir=<scratch>/ud` with `NODE_ENV=development` set for that process only, as `apps/pos/scripts/dev-electron.cjs` does. Without it, main loads the built `dist/renderer/index.html` instead of Vite, so you review a stale or missing renderer.
   - **Always use a scratch `--user-data-dir` from the first launch.** The DB lives in userData. Never touch the owner's `%APPDATA%\pos-pulse`.
   - **Create the scratch profile under a short root** such as `C:\rt\<name>`, written as a Windows absolute path (not `/c/...`). Do not rely on 8.3 conversion (`%~sI`): Windows returns the long path when no 8.3 name exists. Create the directory, confirm the launch user can write to it, and keep the whole path under 60 characters (a conservative bound well below the 260-character Windows limit, leaving room for Chromium's nested files; not a measured Chromium limit); stop before launch if any check fails. Chromium silently ignores a path it cannot create (too long or denied) and falls back to `%APPDATA%\pos-pulse`, running migrations on the owner's real DB; a session scratchpad path is long enough to trigger this.
   - **Before any interaction**, confirm the scratch dir gained `pos-pulse.db` and the owner's `%APPDATA%\pos-pulse` files did not change.
   - The dev catalogue seed is skipped if ANY tenant has products. A fresh profile fixes "0 products".
3. Env flags as needed, each = `1`: `POS_PULSE_DEV_SKIP_PAIRING`, `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN`, `POS_PULSE_DEV_SEED_CATALOGUE`, `POS_PULSE_FEATURE_CART`, `POS_PULSE_FEATURE_PRODUCT_SEARCH`, `POS_PULSE_FEATURE_PAYMENTS`. `POS_PULSE_FEATURE_PAYMENTS` needs `POS_PULSE_FEATURE_SALE_FINALIZATION=1` too; with payments on and finalization off, main refuses to start (`src/main/app/feature-flags.ts`).
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
