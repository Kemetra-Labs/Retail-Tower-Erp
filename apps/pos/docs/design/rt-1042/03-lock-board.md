# RT-1042 S6 — Lock board (RT-1095)

**Status: owner-approved 2026-11-04** (RT-1095 comment 15403, «owner 2026-11-04 via coordinator»):
L-1 board approved as drawn here, L-2 (a), L-3, L-4 and L-5 as recommended. This board is text
because the lock changes no composition the Direction B boards do not already draw: it is
Direction B's Ink band over the same PIN dock. Captures of the built screen come from GitHub
Actions and go on RT-1095.

## Decisions

| #   | Decision                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------- |
| L-1 | This board, as drawn below.                                                                                         |
| L-2 | **(a)** The lock uses the same Ink band family as sign-in. The lock renders the shared `EntryBand` (RT-1096, #295) unchanged; no second band is built.     |
| L-3 | Format copy is sign-in's own: error «الرقم السري من 4 إلى 6 أرقام.», hint «من 4 إلى 6 أرقام.». No English (G-1 §5). |
| L-4 | «قليلًا» in `rate_limited` on lock and sign-in.                                                                      |
| L-5 | The lock's own refusal family stays as shipped (generic; manager no-connection line).                               |

L3 is kept: nothing of the sale is shown, and there is no ornament (OD-5).

## Layout (cashier, 1280×800 and above)

```text
┌──────────────────────────── Ink band (data-entry-surface) ────────────────────────────┐
│ [mark on a Mint tile]  Retail Tower                                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
        [tenant logo 200×80, in the dialog, never on Ink]
        الطرفية مقفلة
        أدخل الرقم السري للمتابعة.
        فتح القفل لـ  <اسم الكاشير>
        ┌────────────────────────┐   dots (LTR, focused on open, aria-label «أُدخل n من 6»)
        │   ●  ●  ○  ○  ○  ○     │
        └────────────────────────┘
        من 4 إلى 6 أرقام.            ← feedback slot: hint, replaced by the refusal (role=alert)
        [1][2][3]
        [4][5][6]                    keypad: LTR, fixed, never reflows (sign-in's PinPad)
        [7][8][9]
        [  ][0][⌫]
        [        فتح القفل        ]  ← the one Teal commit (OD-2); inert under 4 digits
        [ دخول موظف آخر ]            ← kept
        Powered by Retail Tower
```

Manager and admin: the same band and frame, with the identifier and password fields and the
«فتح القفل» submit in place of the dock (no keypad: the credential is online text).

## States

| State                    | Feedback slot                                         | Dots / keypad                                  |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------- |
| Open                     | hint «من 4 إلى 6 أرقام.»                              | dots focused; keypad live                      |
| Typing (1–3 digits)      | hint                                                  | filled dots; commit `aria-disabled`            |
| Ready (4–6 digits)       | hint                                                  | commit live                                    |
| Busy                     | hint                                                  | keys disabled                                  |
| Refused `invalid_input`  | «تعذّر فتح القفل. تحقّق من البيانات وحاول مرة أخرى.»   | dots cleared, `data-error`, refocused          |
| Refused `rate_limited`   | «محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.»        | dots cleared                                   |
| Scan burst               | the scan guard restores the dots (M-S5); never reaches main | dots unchanged                           |
| Forced colours           | text; the band maps to Canvas / CanvasText with a 1px edge | keys keep the 1px CanvasText border      |

## Keyboard parity with sign-in's PIN dock

Digits `0–9`, Backspace and Enter work from the hardware keyboard anywhere in the dialog. Esc
clears the entry and keeps the lock. Tab stays inside the dialog. Keys never reach the sale behind
the lock. The scan guard (capture listener on `window`) runs first, as on sign-in.

## Band

The lock renders `EntryBand` as-is (the mark on a Mint tile and «Retail Tower»), pinned at the top
over the opaque backdrop. The tenant logo stays in the dialog, never on Ink, so OD-10's white card
is not needed. The band's own forced-colours mapping (Canvas, a 1px edge, no Mint) applies.
