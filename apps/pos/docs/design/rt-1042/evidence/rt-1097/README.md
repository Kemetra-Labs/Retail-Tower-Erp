# RT-1097 (RT-1042 S8): packaged verification of the entry screens

Work Mode: Verification. Nothing here fixes a defect; each failure names its first failing
boundary. Owner decisions for the method: RT-1097, "owner 2026-11-04 via coordinator".

## Evidence labels

| Label | What it is | What it is not |
|---|---|---|
| **R-dev** | Unpackaged `electron .` of `main`, Vite dev renderer, CDP `Page.captureScreenshot` at an exact viewport (`Emulation.setDeviceMetricsOverride`, DPR 1). Forced colours are CDP `Emulation.setEmulatedMedia` `forced-colors: active`. Scratch `--user-data-dir`, deleted after the run (two profiles first landed under `C:\tmp\…` because of a Git Bash path; found and deleted, no pairing attempt in either). | Not the packaged exe, not the production bundle, not a Windows contrast theme. |
| **R-dev fixture mount** | Same window and CSS; the real component module (`RouteLoading`, `LockScreen`, `TakeoverPrompt`) is imported from the Vite dev server and rendered with fixture props in place of `#root`. Used where the state cannot be reached without a backend (boot is transient; a cashier lock needs a cashier session; takeover needs a backend `takeover_required`). `SessionLockGate` renders `LockScreen` directly and the sign-in route wraps `TakeoverPrompt` in `<main dir="rtl">`, which the mount copies. | Not the state machine that reaches the screen. |
| **R-pkg** | The CI-built `pos/package-windows` artifact, OS screenshots only (the packaged exe refuses CDP by design, `launch-switch-guard.ts`). | Pending: after RT-1093 merges. |
| **Owner** | A person at the device: contrast theme, screen reader, real scanner. See [`owner-checks.md`](owner-checks.md). | Pending. |

The tenant logo is a fixture (an orange «FIXTURE» SVG, injected into the renderer branding
store with the RT-475 slot sizes). It is not a real tenant's logo.

## Baseline

- `origin/main` `2cf86978f` (RT-1095, #296). Electron 44.9.1.
- Native modules for the R-dev run were copied from the CI artifact
  `pos-pulse-win-unpacked-2cf86978…` (run 41813056875), because this laptop has no Visual Studio
  toolchain for `electron-rebuild`. Artifact hashes: `POS Pulse.exe` sha256 `06f7c58d…f5d2`,
  `resources/app.asar` sha256 `27d518c4…ea1b`.

## Metrics

`r-dev/metrics.jsonl` has one line per capture: viewport, `forced-colors` match, page scroll,
inner scroll containers (`class:overflow px`), controls under 44 px, key elements outside the
viewport, and the band width.

## Results: non-sign-in screens (R-dev)

Files are `r-dev/<screen>-<w>x<h>[-fc].webp`; each set is 1024×600, 1024×768, 1280×800 and
1920×1080, light and forced colours.

| Screen | Set | Result |
|---|---|---|
| Pairing, no logo | `pairing-*` | **Pass.** Fits at all four sizes, no scroll, full-width band, no target under 44 px. |
| Pairing, with logo | `pairing-logo-*` | **Pass at 1024×768 and up. Observation at 1024×600:** the card scrolls 30 px inside `.v5-entry__center`; the commit button stays visible and the powered-by line sits at the fold. |
| Ready | `ready-*` | **Pass.** Fits at all sizes. Ready has no logo slot (RT-475 slots are boot, pairing, sign-in, lock), so there is no logo variant. |
| Boot, no logo / with logo | `boot-nologo-*`, `boot-logo-*` | **Fail (F1).** The Ink band is not full width: about 205 px wide and centred in a 1536 px window, at every size and in forced colours. |
| Lock, cashier, no logo | `lockgate-cashier-*` | **Fail (F2) below 1920×1080.** The dialog scrolls: 182 px at 1024×600, 14 px at 1024×768, 30 px at 1280×800. At 1024×600 the keypad's last rows and «فتح القفل» are below the fold, and «دخول موظف آخر» overlaps the keypad. |
| Lock, cashier, with logo | `lockgate-cashier-logo-*` | **Fail (F2).** Scrolls 352 / 184 / 200 px at 1024×600 / 1024×768 / 1280×800; fits only at 1920×1080. |

The cashier lock sets come from the repo's own dev harness `#/dev/sign-in-proof?screen=locked`
(RT-244/RT-444), which renders the real `SessionLockGate` over the real sign-in route with an
in-memory bridge. A first pass through the fixture mount gave the same scroll values; it was
replaced. The PIN read «أُدخل 0 من 6» before and after each set.
| Lock, manager, no logo | `lock-manager-*` | **Pass.** Fits at all sizes. |
| Lock, manager, with logo | `lock-manager-logo-*` | **Observation at 1024×600:** scrolls 52 px. Fits at 1024×768 and up. |
| Takeover prompt | `takeover-*` | **Layout pass, copy fail (F3).** Fits at all sizes with the shared band. The copy is English inside an RTL container, so the sentence punctuation renders at the wrong end («.terminal in this branch», «?Continue here…»). |

Forced colours (emulated): on every screen above, the band, cards, inputs, keys and buttons
draw in system colours with visible 1 px edges; no Mint or Ink remains. This is Chromium's
emulation, not a Windows contrast theme (owner check 1).

## Findings (first failing boundary; not fixed here)

- **F1. Boot band not full width.** `src/renderer/v5/foundation/route-states.css`:
  `.v5-route-state` sets `place-items: center`; `.v5-route-state--entry` switches to
  `display: flex; flex-direction: column` without resetting `align-items`, so the band
  (`.v5-entry-band`, no inline size) is not stretched. Pairing and Ready (`EntryCardScreen`) are
  not affected. Source: RT-1096 S7 (#295). RT-1096's tests check structure and roles, not
  computed width. Measured through the fixture mount of the real `RouteLoading` (boot is
  transient in the routed app); the packaged pass is to confirm it on the real boot screen.
- **F2. Cashier lock does not fit below 1920×1080.** The `.v5-dialog.v5-live-dialog` panel
  is capped by `max-block-size: calc(100dvh - 52/64px - 2 * gutter)`
  (`src/renderer/session/lock-screen.css`), and the cashier content (title, prompt, dots,
  hint slot, 4-row keypad, commit, switch-operator, powered-by, plus the 200×80 logo when set)
  is taller than that, so the panel scrolls. RT-1095 (#296) recorded the 1024×600 fit as
  "by CSS design, not captured". The sign-in PIN dock is not affected by this (it is another
  layout; sign-in captures follow RT-1093).
- **F3. Takeover prompt copy is English (pre-existing, outside RT-1096's scope).**
  `src/renderer/ui/operator/TakeoverPrompt.tsx:141`. The copy predates RT-1042 (spec 004,
  2026-05) and RT-1096 kept it unchanged on purpose, so this is not an S7 failure. In the RTL
  entry family the sentence punctuation is misplaced. Arabic copy needs an owner copy decision.

## Run log

- 12:33 and about 12:45 Cairo: keystrokes not sent by the driver reached the dev window (a
  16-character value typed into the pairing field and submitted three times; later six digits
  into the lock PIN pad). The dev build has no backend (`https://example.invalid`), so nothing
  left the machine and nothing was logged. The affected captures were deleted and retaken. The
  likely cause is the dev window taking keyboard focus at launch while the PC was in use; after
  that, the window was moved behind other windows without focus (`ShowWindow` minimise then
  `SW_SHOWNOACTIVATE`, `HWND_BOTTOM`) and no further input arrived.

## Pending

- Sign-in (roster loading, roster, PIN with a refusal above the dots) at four sizes and forced
  colours: after RT-1093 merges.
- Simulated scanner bench (no cashier picked, during PIN, during manager password; where M-S5
  shows): after RT-1093 merges, with the sign-in run.
- Packaged captures (R-pkg): after RT-1093 merges; the owner types the pairing code and PIN.
- Owner checks: [`owner-checks.md`](owner-checks.md). Blocked on the owner until he reports.
