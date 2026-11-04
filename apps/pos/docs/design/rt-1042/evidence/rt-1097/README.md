# RT-1097 (RT-1042 S8): packaged verification of the entry screens

Work Mode: Verification. Nothing here fixes a defect; each failure names its first failing
boundary. Owner decisions for the method: RT-1097, "owner 2026-11-04 via coordinator".

## Evidence labels

| Label | What it is | What it is not |
|---|---|---|
| **R-dev** | Unpackaged `electron .` of `main`, Vite dev renderer, CDP `Page.captureScreenshot` at an exact viewport (`Emulation.setDeviceMetricsOverride`, DPR 1). Forced colours are CDP `Emulation.setEmulatedMedia` `forced-colors: active`. Scratch `--user-data-dir`, deleted after the run (two profiles first landed under `C:\tmp\…` because of a Git Bash path; found and deleted, no pairing attempt in either). | Not the packaged exe, not the production bundle, not a Windows contrast theme. |
| **R-dev fixture mount** | Same window and CSS; the real component module (`RouteLoading`, `LockScreen`, `TakeoverPrompt`) is imported from the Vite dev server and rendered with fixture props in place of `#root`. Used where the state cannot be reached without a backend (boot is transient; a cashier lock needs a cashier session; takeover needs a backend `takeover_required`). `SessionLockGate` renders `LockScreen` directly and the sign-in route wraps `TakeoverPrompt` in `<main dir="rtl">`, which the mount copies. | Not the state machine that reaches the screen. |
| **R-pkg** | The CI-built `pos/package-windows` artifact of `c263f18a`, run on this laptop with a scratch profile against the rt9 lab, captured with Win32 `PrintWindow` cropped to the client area. No input was sent by the agent; the owner typed the pairing code and the sign-in. Forced colours are the Chromium flag `--force-high-contrast`. | Not a Windows contrast theme; no CDP (the packaged exe refuses it by design, `launch-switch-guard.ts`). |
| **Owner** | A person at the device: contrast theme, screen reader, real scanner. See [`owner-checks.md`](owner-checks.md). | Blocked on the owner. |

The tenant logo is a fixture (an orange «FIXTURE» SVG, injected into the renderer branding
store with the RT-475 slot sizes). It is not a real tenant's logo.

## Baseline

- Non-sign-in screens: `origin/main` `2cf86978f` (RT-1095, #296). Sign-in and the bench: `c263f18a5` (RT-1093, #300). Electron 44.9.1.
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

## Results: sign-in (R-dev, `main` `c263f18a`, after RT-1093)

Captured through the repo's dev harness `#/dev/sign-in-proof` (the real `SignInRoute` with an
in-memory bridge; RT-244), except roster loading, which the harness cannot show: there the real
`SignInRoute` is mounted inside `SupportedViewport` and `MemoryRouter`, as the router mounts
it, with a roster call that never resolves.

| State | Set | Result |
|---|---|---|
| Roster loading | `signin-roster-loading-*` | **Pass.** «جارٍ تحميل قائمة الكاشير…» in the roster card; fits at all sizes. |
| Roster, 6 cashiers, no cashier picked | `signin-roster-*` | **Pass.** 2 columns below 1280 px, 3 at 1280 and up (OD-11); PIN dock fixed; no scroll; band with the RT-1093 ornament. |
| Roster with tenant logo | `signin-roster-logo-*` | **Pass.** 128×32 logo on the white card in the band (OD-10), powered-by line; fits at all sizes. |
| Long roster (18 cashiers) | `signin-roster-long-*` | **Pass.** Only the roster list scrolls (`.v5-entry__roster`: 214 / 130 / 26 px at 1024×600 / 1024×768 / 1280×800); PIN dock and band stay put. |
| Cashier picked, PIN 2 of 6 | `signin-pin-*` | **Pass.** Fits at all sizes. |
| Refusal | `signin-refusal-*` | **Pass (OD-7).** «بيانات الدخول غير صحيحة. حاول مرة أخرى.» sits above the dots (refusal bottom 193 px, dots top 228 px at 1024×600). |

Forced colours (emulated): band, cards, roster tiles, keys and the refusal draw in system
colours; the selected cashier uses the system highlight; no Mint or Ink remains.

Observation (for owner check 2): the refusal text is exposed in two live regions at once, a
`role="status"` and a `role="alert"` (`.v5-notice`) at the same spot, which a screen reader may
read twice.

## Scanner bench, simulated (R-dev, `main` `c263f18a`; the same results as a dry run on `2cf86978`)

Method: the repo's `#/dev/sign-in-proof` tree rendered over the real `App` (its
`ScanGuardHost` is the only guard and is registered first, as in production). A burst is
`6221000000011` then Enter, sent as CDP `Input.dispatchKeyEvent` to the dev page only,
pipelined about 4 ms apart (max measured gap 16.5 ms; the guard's limit is 35 ms). Label:
R-dev simulated; not a real scanner (owner check 3).

| Step | Where the burst landed | Notice and where | Field after | Submitted? |
|---|---|---|---|---|
| S1 | Sign-in, no cashier picked | «المسح غير متاح» (M-S1), global scan notice | (no field) | No |
| S2 | Cashier picked, PIN 2 of 6 | M-S5 «لا يُقبل المسح في حقل الرقم السري…», global scan notice, **not** the PIN slot above the dots | PIN restored to 2 of 6 | No |
| S3 | Manager form, password with 2 characters | M-S5 (the PIN wording), global scan notice | password restored to 2 characters | No |
| S4 | Lock, cashier PIN 2 of 6 | M-S5, global scan notice | PIN restored to 2 of 6 | No |

Observation: on the manager password the notice says «حقل الرقم السري» (PIN field) for a
password field; the M-S5 family has no password wording (`scan-messages.ts`).

Where the notice appears (`bench-s2-1024x600.png`, `bench-s4-1024x600.png`): a fixed toast at
the top centre (z-index 2000), over the Ink band and, on the lock, above the dialog. At 1024 px
it covers part of the band's terminal label. On sign-in it is about 700 px from the PIN dots in
the dock. (These two shots show a page scrollbar that comes from the harness, which un-hides the
App root so its notice is visible; it is not in the app.)

## OD-15 recommendation (from the simulated bench; to be confirmed by owner check 3)

**In-slot.** The guard already does the safe part everywhere: no digit lands in the PIN or the
password, and nothing is submitted. What OD-15 decides is only where M-S5 shows. Today it shows
only in the global toast at the top centre, far from the dock where the cashier is looking and
over the band's terminal label at 1024 px, while the PIN feedback slot above the dots, where the
refusal already shows (OD-7), stays empty. Showing M-S5 in that slot, and keeping the toast for
the screens without a slot (no cashier picked, M-S1), puts the message where the eyes are. The
manager password and the lock PIN would need the same treatment, and the password case needs a
password wording. The real scanner (owner check 3) should confirm the bursts behave as above
before this is decided.

Method lessons: a per-key CDP round trip (16–39 ms gaps) and an Enter sent from a second
process are not a burst, so the guard correctly treats them as typing; and a guard mounted
after the PIN pad, with no App guard, left the burst's digits in the PIN (listener order), which
production does not do. Neither appears in the table above.

## Screen reader proxy: roster loading (R-dev, not a screen reader)

The real `SignInRoute` with a roster call that never resolves. A `MutationObserver` started
before the mount shows the `role="status"` element inserted 5 ms after mount, inside the
screen's first render, **with its text already in it**
(«جارٍ تحميل قائمة الكاشير…»; no `aria-live`/`aria-atomic` attribute beyond the role).
A live region that appears together with its content is commonly not announced, so the
CodeRabbit concern on PR #274 is plausible. This is a DOM proxy only; the result comes from
owner check 2 (Narrator / NVDA).

## Results: packaged (R-pkg, `c263f18a`)

Artifact `pos-pulse-win-unpacked-c263f18a…` (main run 41818778020): `POS Pulse.exe` sha256
`960c876a…b223`, `resources/app.asar` sha256 `21eabd80…9712`;
the asar contains the RT-1093 ornament. The display is 1920×1080 at 125 % (DPI 120), so each CSS
size was a physical client of ×1.25 (1280×750, 1280×960, 1600×1000 and 2400×1350; the window
accepts a client larger than the screen). The packaged window has no native menu bar, so the
client area is the page. Files are `r-pkg/<screen>[-fc]-<w>x<h>.png` (CSS size in the name).

| Screen | Set | Result |
|---|---|---|
| Pairing | `pairing-*`, `pairing-fc-*` | **Pass.** Same layout as R-dev at all four sizes, light and forced colours. |
| Sign-in, empty roster | `signin-empty-*`, `signin-empty-fc-*` | **Pass.** Band with the terminal label «dsad», ornament, PIN dock and «دخول المدير»; no scroll at any size. The roster is empty («لا يوجد كاشير مسجّل في هذا الفرع») because the new terminal has no cashier with a PIN. |
| Ready | (none) | **Not captured packaged; covered by R-dev only.** Ready shows once, right after pairing; a restart of a paired terminal goes to sign-in (or to the app while a session is held). |
| Boot | (none) | **Not captured packaged.** Too short on this machine; F1 rests on R-dev and the CSS. |
| Sign-in PIN entry, refusal, lock | (none) | **Not captured packaged.** Owner action: give a lab cashier a PIN on this terminal («إدارة الكاشير»), then sign in as that cashier. |
| Takeover | (none) | **Not captured packaged** (needs a second terminal); R-dev only. |

Frames that showed part of the manager's login id (the dashboard after the owner signed in)
were deleted and are not in this folder. The pairing field is empty in every committed frame.

**F4. The window title still says «POS Pulse» (OD-8).** `apps/pos/src/renderer/index.html`
has `<title>POS Pulse</title>` and `electron-builder.yml` has `productName: POS Pulse`, so the
title bar and the taskbar read «POS Pulse» while the band says «Retail Tower». RT-1092 changed the
strip to «Retail Tower» (OD-8) but not the window title.

The lab terminal «dsad» created by this run stays paired to the rt9 store. The owner can revoke
it from the Admin Console if it is not wanted.

## Pending

- Packaged PIN entry, refusal and lock: not captured (owner action above).
- Owner checks: [`owner-checks.md`](owner-checks.md): contrast theme, Narrator/NVDA on roster
  loading (and the doubled refusal live region), real scanner. Blocked on the owner.
