# Review checklist (use for screens, diffs, PRs)

Scan in order. Cite the rule ID. Mark anything you cannot prove from code or a capture as "Needs verification" rather than a defect (UX-11.29).

## Blocker (breaks a non-negotiable or an RT-24 invariant)

- [ ] Success wording/colour shown before the fact is persisted or proven (UX-05.16, UX-01.19, I-7).
- [ ] UNKNOWN worded or styled as a decline; any re-charge, new tender, Back or sign-out reachable in UNKNOWN (UX-05.25, UX-12.15, I-7).
- [ ] Scanner burst can reach a money, PIN or card-reference field, or activate a focused control; scanner Enter can tender (I-4, UX-08.17). Keyboard Enter on a focused financial button is an open owner question (`pos.md`), not a Blocker.
- [ ] Cart or tender can be silently discarded (inactivity, sign-out, restart, Back after funds applied) (RT-24 rule 1, I-8, I-12).
- [ ] Recovery action can create a second sale or payment (RT-24 rule 3).
- [ ] Undo offered where the domain cannot restore, or composed in the renderer (UX-05.21, RT-245).
- [ ] Money animated (rolling/count-up) or rounded silently; floating-point money (UX-06.13, UX-08.11-.12).
- [ ] Invented connectivity/sync/online state, or fiscal/VAT/QR/"Fiscal Ready" claim (UX-07.4, I-17).
- [ ] Lock screen shows lines or amounts; lock discards or reverses tender (L3, RT-161, RT-116).
- [ ] Referring a manager credential or approval without action/amount binding; bare manager ID (I-6).
- [ ] Support-session UI offers a write; tenant existence disclosed to the wrong party (RT-391/RT-414).

## Major (violates a Constitution rule)

- [ ] More than one primary per region; destructive action in the commit slot or as default focus (UX-05.11-.13).
- [ ] Hover-only essential action or blocking reason (UX-05.7, UX-11.11).
- [ ] `aria-modal` without a Tab trap, or focus not returned to intent (UX-11.9, .8).
- [ ] Focus indicator is box-shadow only; focus can be obscured by sticky regions (UX-11.4-.6).
- [ ] Colour is the only carrier of meaning; status colours used as decoration or chart series (UX-02.9, UX-13.12).
- [ ] Physical left/right CSS, missing `dir`/`lang`, unisolated machine data in RTL (UX-11.12-.15).
- [ ] Non-Western digits or ungrouped/oddly formatted money in system output; device-locale dependent formatting (UX-12.20, .25, .26).
- [ ] English copy on POS other than source data, standard abbreviations and IDs (EGP, SKU, ERPNext; POS DESIGN.md One-Locale Rule) (Admin's separate English locale is allowed); bilingual duplicate copy on either surface; raw codes/keys/backend text shown; generic "Retry" or "OK" (UX-12.2-.3, .6, .33-.34).
- [ ] Wrong terminology (الفرع for Store, leaking `tenant_product`, receipt called invoice) (UX-12.14, .16-.19).
- [ ] «طُبع» without print proof; blanket «تمت العملية بنجاح» (UX-12.12-.13).
- [ ] Table inside a card, nested cards, gradient or glass surfaces (UX-04.16, UX-01.28-.29, UX-02.13).
- [ ] Table sorts only the loaded page; totals shown without contract; filter change keeps stale selection; rows hidden when a later page fails; mixed snapshots stitched (UX-10.11, .17-.19, .24).
- [ ] Row is an ambiguous click target when it also has selection or actions (UX-10.3-.4).
- [ ] Scope switch or navigation discards unsaved work; deep link silently changes scope (UX-09.8-.10).
- [ ] Save-on-blur for a consequential value; error attached at the wrong level (UX-05.26, UX-08.9).
- [ ] Banner stack pushes the work surface down without an attention budget (UX-04.13, UX-07.23).
- [ ] POS shortcut or F-key invented (D-K1; Admin's Ctrl+K navigator is approved); new package or hard-coded hex added; Gold/navy/dark-only reintroduced.
- [ ] POS: money, commit, cancel/back or scanner state can scroll away at 1024x768 / 1280x800; target below 44px; text below 12px (I-3, UX-04.10-.11, UX-03.14).
- [ ] Chart: truncated bar axis, bare delta, dual axis without justification, missing bucket drawn as zero (UX-13.8, .17, .19, .24).

## Minor

- [ ] Arbitrary motion duration; ease/bounce instead of the three roles; page-load choreography (UX-06.9, .12).
- [ ] Mono used as a "technical" look outside machine IDs (UX-03.11).
- [ ] Icon not from the semantic registry, raw `<svg>`, icon-only on a financial/destructive action, wrongly mirrored or filled icon (UX-03.17-.36).
- [ ] Spacing off the 4px scale; radius off the repo's shipped tokens; shadow on a non-overlay surface (Admin section panels and receipt cards may use `--shadow-resting`).
- [ ] Dubai weight 600 or letter-spacing on Arabic text; Arabic line-height under 1.5.
- [ ] Skeleton shimmer that is long or decorative; loading flash on fast loads (UX-06.21-.22).

## Advisory (not governing; only from `advisory-candidates.md`)

State clearly that these come from the blind-research tier, not the owner-approved rules.

## Output reminder

Findings table: `Severity | Rule ID | Evidence | Fix`. End with "Needs verification" (runtime, packaged build, keyboard-only, forced-colours, reduced motion) and "Open questions" (anything on the still-open list). Do not mark RT items Done or imply implementation approval.
