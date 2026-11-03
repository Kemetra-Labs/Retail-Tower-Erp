# RT-1042 — Sign-in: current-state audit

> **Status: Planning draft (RT-1042), not approved.** This file describes what `origin/main` does.
> It changes nothing. Baseline: `origin/main` at `6e3ffc99` (2026-11-03). Sources read:
> `src/renderer/routes/sign-in.tsx`, `v5/entry/*`, `ui/operator/{PinPad,RosterList,ManagerAdminSignInForm,TakeoverPrompt,messages}.tsx`,
> `branding/BrandSlot.tsx`, `shared/branding/types.ts`, `session/LockScreen.tsx`,
> `routes/pairing/PairingScreen.tsx` and `scan/*`. Nothing here was checked in the packaged app.

## 1. Status of the pieces

| Piece                                                                    | Issue          | Status                                                                                                                                       |
| ------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-zone sign-in (roster at the inline start, fixed PIN column at the end) | RT-244 (G-1, RT-246) | Merged, packaged verification pending (2026-10-20 owner page)                                                                                |
| Tenant logo slots: boot 240×120, pairing 200×80, sign-in 128×32, lock 200×80 | RT-475 (RT-832) | Merged, Jira In Review                                                                                                                       |
| Pharmacy name on the sign-in screen                                       | RT-406 (Done)  | **Not shown, by decision.** The owner removed the name-as-text state on 2026-11-01. The name is only the logo's alt text. This closes the RT-1042 "unknown". |

## 2. Screens and states

**Context strip.** It shows the «POS Pulse» wordmark with the pharmacy cross, then the terminal label (admin free text, in `<bdi>`).

- **Logo cached (`kind: logo`):** the 128×32 `sign_in` slot replaces the mark and the wordmark. «بدعم من Retail Tower» sits at the inline end. With `presentation.card`, the logo sits on a white card. Under forced colours it always does.
- **No logo (`kind: none`, unpaired, or a corrupt cache):** the strip is exactly the old one.
- **Not shown:** a branch name or a connection pill (RT-246 A4 / X-2).

**Roster zone ("who are you").** Five states, and the screen states only what the fetch proved:

| State     | What the screen shows                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `loading` | **An empty panel**: heading only, no statement                                                                           |
| `ready`   | A 2-column grid of name tiles: a one-letter badge (first grapheme) and the name, clamped to two lines. Scrolls in its own region |
| `offline` | Warning: «تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.»                                                                    |
| `refused` | Warning: «تعذّر تحميل قائمة الكاشير.»                                                                                     |
| `empty`   | Info: «لا يوجد كاشير مسجّل في هذا الفرع.»                                                                                  |

- The roster is fetched once, with no retry (RT-246).
- «دخول المدير» is always under the roster. It is not an offline path.

**PIN column ("prove it").**

- **Before a pick:** the heading «الرقم السري», a prompt chosen by the roster state, and a disabled keypad, so picking never reflows the layout.
- **After a pick:**
  - the head shows a badge, the name, «الكاشير» and «رجوع»;
  - below it, six dots (a 4–6 digit PIN);
  - then the reserved feedback slot, **between the dots and the keypad**;
  - then the LTR keypad (1-2-3 on top, ⌫ labelled «حذف»);
  - last, «دخول», which is `aria-disabled` under 4 digits.

**Signing in.**

- The slot shows «جارٍ تسجيل الدخول…».
- The tiles, the manager toggle and «رجوع» are disabled. Alert XOR spinner, in one live region (Note 1).

**Refusal.**

- The PIN clears and the picked cashier stays.
- The slot shows one generic message per category (P11 / PR-2):
  - `invalid_input` (also used for an IPC failure);
  - `no_connection`;
  - `rate_limited`;
  - `terminal_has_unresolved_payment`, the longest (two sentences);
  - the rest of `SIGN_IN_REFUSAL_COPY`.

**`takeover_required`.** The route swaps the whole screen for `TakeoverPrompt`, under the legacy `v4-screen` class. Esc cancels the takeover. The strip and the logo are not shown.

**Manager mode.** The PIN column becomes a form:

- «البريد الإلكتروني أو اسم المستخدم» and «كلمة المرور»;
- the commit «تسجيل الدخول»;
- «رجوع».

A refusal in one path never carries into the other path.

**Related entry screens.**

- **Lock (`LockScreen`):** an overlay dialog that shows nothing of the sale. It has a 200×80 logo slot and a **text PIN field**, not the keypad.
- **Pairing:** a centred card with a 200×80 logo slot.
- **Boot:** a 240×120 logo slot.

## 3. Keyboard and scanner

- **PIN digits.** The pad listens on `window`: digits, Backspace, and Enter (which submits at 4 or more digits). It has no input element, and digits never reach the DOM as text.
- **Tab order.** Roster tiles, then «دخول المدير», then the PIN column. The keypad buttons have visible focus, and every key has an on-screen alternative.
- **No new keys.** No F-keys and no keycaps, as wave 1 is keyless (D-K1).
- **Scanner.** The PIN pad registers the `pin` refuse surface (RT-239). A wedge burst puts back the value from before the burst and raises M-S5: «لا يُقبل المسح في حقل الرقم السري. أدخل الرقم السري بالأرقام.». The notice is drawn by the global `ScanGuardHost`, **not** inside the feedback slot.
- **Needs verification.** Neither of these could be settled from the code read:
  - what a burst does while **no cashier is picked**, when no PIN surface is mounted;
  - what a burst does in the manager password field.

  Both need a scanner bench test.

## 4. Pain points

| #   | Pain point                                                                                                                                                                                                                                   | Evidence                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1  | **Little identity.** The only brand is a 26px mark, a wordmark and a 128×32 logo in a 48px strip. The owner judged the screen too plain.                                                                                                      | RT-1042; `EntryStrip.tsx`                                           |
| P2  | **The pilot display is not designed for.** The stage is capped at 1120px (`entry.css:146`). On the pilot 1920×1080 screen (RT-312), about 800px of canvas is left empty. The G-1 references were drawn at 1024 and 1280 only.             | `entry.css`; G-1 brief §4                                           |
| P3  | **The picked name is small.** The name sits in the PIN column's 16px panel head. A cashier can type a PIN under a colleague's name, and the failed attempt counts toward the colleague's lockout.                                           | `SignInPanels.tsx` `PickedCashier`; RT-1042 idea 3                  |
| P4  | **Loading looks empty.** While the roster loads, the panel is blank with no statement, so a slow fetch reads as "no cashiers".                                                                                                                 | `RosterList` renders `hidden` for an inert roster                   |
| P5  | **Two PIN interfaces.** The sign-in keypad and the lock-screen text field differ. Lock copy «رمز PIN من 4 إلى 6 أرقام.» puts English in Arabic-only copy (G-1 §5). `rate_limited` is spelt «قليلًا» on sign-in and «قليلاً» on lock. The lock has its own refusal family. | `LockScreen.tsx:63-65,135`; `messages.ts`                           |
| P6  | **The takeover prompt looks old.** It renders in the legacy `v4-screen` frame, without the strip.                                                                                                                                              | `sign-in.tsx` (takeover branch)                                     |
| P7  | **The scan notice is far from the PIN.** M-S5 appears in the global notice, away from the PIN the cashier is looking at. Placement on sign-in needs a packaged capture.                                                                     | `ScanGuardHost.tsx`                                                 |
| P8  | **Brand slots don't match.** The sign-in logo (128×32) is much smaller than on lock and pairing (200×80), so the same pharmacy looks different from screen to screen.                                                                         | `BRANDING_SLOT_BOXES`                                               |

Copy changes in P4 and P5 are **proposals**. The current strings are owner-approved (G-1, RT-116), so each one needs an owner decision. See the decision record.

## 5. What any redesign must keep (behaviour authority)

- **Keypad.** It stays in one place in every state and never reflows (G-1 §2 proof).
- **Refusals.** Each category shows its one generic message, with no factor detail and no interpolated input (P11 / PR-2).
- **No retry, no offline path.** The roster has no retry button. There is no offline PIN path and no offline manager sign-in (RT-113 / RT-114).
- **No `Enter` tender.** No new keys, and no keycaps (D-K1).
- **Scan bursts never become a PIN.** A burst never becomes a PIN or a password (RT-239).
- **Formats.** Western digits, the LTR keypad, and text at 12px or more. Targets are at least 44px, keypad keys 56×56 (60×64 comfortable), and the commit is 56/60px (G-1 §5).
- **Logo.** The logo is never stretched, cropped or upscaled. On low contrast and under forced colours it sits on the white card (RT-832).
- **Fit.** It fits at 1024×600 (compact band, RT-407) and is never zoomed (RT-312).
