# RT-1042 — POS sign-in redesign (Planning)

**Status: proposal, not approved.** This folder is the RT-1042 planning deliverable. It changes no
production code and no governing rule.

- **What governs.** Until the owner decides, `docs/DESIGN.md`, the UX Constitution and the G-1
  references (RT-246) govern the sign-in screen. **Rules win over boards.**
- **The copy.** The boards draw the copy shipped on `main` (`v5/entry/entry-copy.ts`,
  `ui/operator/messages.ts`). Anything new is marked «مقترح» on the board and listed in the
  decision record.
- **The data.** Names, the terminal label and the manager identifier are examples. The tenant logo
  is a labelled placeholder box at the RT-832 size.

| File                                                   | What it is                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-sign-in-audit.md`](01-sign-in-audit.md)           | Current state on `origin/main`: screens, states, keyboard and scanner, pain points P1–P8, what a redesign must keep                          |
| [`02-decision-record.md`](02-decision-record.md)       | The three directions, owner decisions OD-1…OD-15 with recommendations, next screens, proposed implementation issues S1–S8                    |
| [`prototype.html`](prototype.html)                     | Interactive prototype of all three directions. Open it in a browser; it needs no runtime. It never checks a PIN: you pick the outcome         |
| `boards/Direction-{A,B,C}-*.dc.html`                   | Per direction: a main board (1920×1080 hero plus 1024×768 and 1024×600) and a states board (20 states)                                       |
| `boards/canvas-2026-11-01/`                            | The owner's design-session canvas boards (A–J; board A is `Main.dc.html`, states are `SignIn` and S2–S6), copied unchanged as non-approved reference (canvas: claude.ai artifact `MjeRvpPxii3GMnb8DNP6L4`, private) |

## Reading the boards

- **Format.** The boards use the canvas `.dc.html` format (as in `apps/admin-console/docs/design/v9/`).
  The canvas runtime `support.js` is not included, but these boards are plain markup and render in
  a browser on their own. The owner's canvas copies under `canvas-2026-11-01/` need the canvas
  runtime for their repeated rows.
- **Frames.** Each frame is drawn at its real pixel size and scaled with CSS `zoom` (Chromium).
- **Forced colours.** The forced-colours frame is a **simulation**. A real Windows contrast-theme
  capture is evidence for the implementation slice.
- **Not verified.** Nothing here was checked in the packaged Electron app. Fit was checked only in
  the browser, by an overflow scan of every frame.

## States covered by each states board

1. Before a pick, with no logo
2. Before a pick, with a logo
3. Picked with 4 digits, logo on a white card
4. Signing in
5. `invalid_input`
6. `rate_limited`
7. `terminal_has_unresolved_payment` at 1024×600 (the longest refusal)
8. M-S5 scan refusal (proposal)
9. Roster loading
10. Roster offline
11. Roster refused
12. Roster empty
13. 18 cashiers with long names
14. 2 cashiers
15. Manager sign-in
16. Manager `no_connection`
17. 1024×768
18. 1024×600 with 18 cashiers
19. 1920×1080 with a logo
20. Forced colours (simulated)

These are not drawn because they do not change: `takeover_required` (`TakeoverPrompt`), Ready,
Pairing and the manager re-auth dialog.
