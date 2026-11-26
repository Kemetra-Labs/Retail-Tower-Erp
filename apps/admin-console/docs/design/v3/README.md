# Admin Console «Console system v3»: board sources

These are the source files of the 12 boards on the page «Console system (D7/D8)» of the design
canvas <https://claude.ai/artifact/UM38B46McW41STtVDrY5Pi> (private). They are snapshot v3 from
2026-11-26, the version the owner adopted (RT-1608, decision D9). They are kept here so every
v3 slice can point at a fixed, versioned copy (RT-1609).

- **Rules win over boards.** `DESIGN.md` §13 is the authority. Where a board and §13 differ,
  §13 wins. The known differences are listed in §13. For example, control borders in §13.2:
  the boards draw input and chip edges with the decorative border colour, but §13.2 requires
  the control-boundary role.
- **How to read them.** Each file holds the board's markup, inline styles and sample data. The
  canvas runtime (`support.js`) is not included, so a file does not render on its own. Read it
  for layout, copy, tokens and states, or open the canvas link above. The yellow English strip
  at the top of each board is a planning annotation, not product UI.
- **Sample data is illustrative.** Store names, people, amounts and receipt numbers are
  invented. New copy needs UX-12 review and a message key.
- **Tags on the boards:**
  - CONCEPT: no contract exists yet.
  - BLOCKED C3: needs the per-store read.
  - NEEDS VERIFICATION: a behaviour to confirm on `main` before building.
- **Fonts on the boards** are Google-hosted stand-ins (IBM Plex Sans Arabic, Noto Kufi
  Arabic). The typeface is an open decision (§13.4). The Console never loads Google Fonts at
  runtime.
- **Not included here:**
  - The earlier explorations on the same canvas: the pages «Journeys», «Concepts &
    workspaces», «Modern directions» and «Directions».
  - The two alternative looks, Hairline and Ink Evolved.

  All of them stay on the canvas as history.

| Board file | What it shows | Slice |
| --- | --- | --- |
| [`S0-System.dc.html`](boards/S0-System.dc.html) | Palette, type scale, spacing and shared patterns | V3-1 (RT-1609), V3-2 (RT-1610) |
| [`S12-Route-map.dc.html`](boards/S12-Route-map.dc.html) | Every current route → new area and tab, with role gate; INVENTED and NEEDS VERIFICATION rows | V3-4 |
| [`S1-Home.dc.html`](boards/S1-Home.dc.html) | Home, Arabic: pipeline strip, «يحتاج قرارك», receipt strip, trend, latest sales, side column | V3-5 |
| [`S8-Home-en.dc.html`](boards/S8-Home-en.dc.html) | Home, English LTR | V3-5 |
| [`S11-Home-dark.dc.html`](boards/S11-Home-dark.dc.html) | Home, dark theme | V3-2, V3-5 |
| [`S2-Sales.dc.html`](boards/S2-Sales.dc.html) | Sales: list with filters, sorted table, selected row, side drawer | V3-9 |
| [`S3-Items.dc.html`](boards/S3-Items.dc.html) | Items index | V3-4 (area and tabs) |
| [`S4-Inventory.dc.html`](boards/S4-Inventory.dc.html) | Inventory overview tab, Arabic | V3-4; overview content is CONCEPT (RT-1430) |
| [`S9-Inventory-en.dc.html`](boards/S9-Inventory-en.dc.html) | Inventory overview tab, English LTR | as above |
| [`S5-Reports.dc.html`](boards/S5-Reports.dc.html) | Reports list with today's «يجيب عن:» framing | V3-8 |
| [`S6-Accounting.dc.html`](boards/S6-Accounting.dc.html) | Accounting: status sentence, figures, decision card, technical details | V3-7 |
| [`S7-Settings.dc.html`](boards/S7-Settings.dc.html) | Settings: stores tab | V3-4 |
