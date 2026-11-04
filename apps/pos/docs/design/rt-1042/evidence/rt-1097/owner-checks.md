# RT-1097 owner checks (contrast theme, screen reader, real scanner)

These three checks need a person at a real Windows device. They cannot be automated
honestly: the packaged POS refuses remote debugging, a screen reader's speech is not
visible to a script, and a keyboard-wedge scanner's timing is the thing being tested.

Use the **packaged** POS (the `pos/package-windows` build of the `main` commit named in
`README.md` here), paired to the lab tenant rt9. You type the pairing code and every PIN
or password yourself. Record each result in the table at the end and post it on RT-1097
(or tell the coordinator session, which will post it).

Time needed: about 15 minutes.

## 1. Windows contrast theme (forced colours)

1. Open **Settings > Accessibility > Contrast themes**. Pick **Night sky** and press
   **Apply**. (Optional second pass: **Desert**.)
2. With the POS open, look at each screen you can reach: pairing (before pairing),
   boot (just after launch), Ready, sign-in (roster, then a cashier's PIN), lock (lock
   the session, then unlock), and the takeover prompt if it shows.
3. For each one, check:
   - all text is readable, and every button and the PIN dots have a visible edge;
   - the band at the top is drawn in the system colours (no Mint green, no dark Ink);
   - the focus ring is visible when you press Tab;
   - a refusal (enter a wrong PIN once) is readable and sits above the dots.
4. Take a screenshot of each screen with **Win+Shift+S** (or Print Screen) and save the
   files in one folder.
5. Set the contrast theme back to **None** when you are done.

## 2. Screen reader: is the roster-loading message announced?

RT-1094 added «جارٍ تحميل قائمة الكاشير…» in a `role="status"` region. The open question
(a CodeRabbit thread on PR #274) is whether a status region that appears with its text
already inside is read out on first render.

1. Turn on **Narrator** (Ctrl+Win+Enter). If NVDA is installed, repeat with NVDA later.
2. The roster loads quickly on a good connection. To see the loading state, start the POS
   with the network cable or Wi-Fi off for a few seconds, then reconnect, or sign out and
   watch the sign-in screen as it opens.
3. Listen as the sign-in screen opens. Note whether Narrator says
   «جارٍ تحميل قائمة الكاشير…» (or anything about loading) before the cashier names.
4. Record: announced / not announced / not sure, and which screen reader and voice.
5. Turn Narrator off (Ctrl+Win+Enter).

## 3. Real scanner bench on sign-in (answers OD-15)

Use the USB barcode scanner and any product barcode. On each step, scan once and watch
where the message «لا يُقبل المسح في حقل الرقم السري. أدخل الرقم السري بالأرقام.» (M-S5)
or any other scan notice appears.

| # | Where you are | What to do |
|---|---|---|
| S1 | Sign-in, **no cashier picked** | Scan once |
| S2 | Cashier picked, **during PIN entry** (type 2 digits first) | Scan once, then check the dots |
| S3 | Manager sign-in, **in the password field** | Scan once, then check the field |
| S4 | Lock screen, cashier PIN | Scan once |

For each, record:

- Did a message show? Its text, and where: in the global scan notice (top/bottom of the
  screen) or inside the PIN feedback slot above the dots.
- Did any digit or character from the barcode land in the PIN or the password?
- Did the screen submit or sign anyone in? (It must not.)
- Take a photo or screenshot.

## Results

| Check | Result | Notes / file |
|---|---|---|
| 1 Contrast theme (Night sky) | | |
| 1 Contrast theme (Desert, optional) | | |
| 2 Narrator, roster loading | | |
| 2 NVDA, roster loading (optional) | | |
| 3 S1 no cashier picked | | |
| 3 S2 during PIN | | |
| 3 S3 manager password | | |
| 3 S4 lock PIN | | |
