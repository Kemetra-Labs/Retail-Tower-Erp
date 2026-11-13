# Retail Tower Control Room: a live Port board

Status: owner-approved design (mockup v13, 2026-11-13). Jira: RT-1381. Related: RT-617 (Observability), PR #556 (the first architecture map plugin, `tools/port-plugins/rt-architecture-map/`).

Mockup: [2026-11-13-rt-control-room-mockup.html](2026-11-13-rt-control-room-mockup.html), a self-contained HTML file with a real Port snapshot of 2026-11-13. Open it in a browser.

## 1. Intent

One live board, inside Port, that connects every Retail Tower service and every tool the project is linked to (Sentry, Datadog, GitHub, Jira), drawn like a power-grid control room: every station, every cable and what it carries, and where each fault comes from.

It serves two audiences:

- **The team**, every day: see at a glance what is broken, where it started, and whether the monitoring itself is working.
- **An investor or visitor**: see how connected and well-run the project is, in plain words, without hiding problems.

The owner's words: a living board "كأننا بنراجع على المشروع", like a national grid control room that shows every station and every cable and where errors come from, without needless visual complexity, without dropping important information, and beautiful.

## 2. Goals, non-goals, anti-goals

Goals:

- Every service is a station; every link between them is a cable labelled with what it carries and its state.
- Every alarm sits where the fault is (on the cable or inside the station), with one icon and one motion per kind, and is listed in an alarm panel with its message, origin and path.
- Show whether each source (Sentry, Datadog, GitHub, Jira) reaches Port, and whether each service sends to Sentry and Datadog.
- Show the delivery pulse (merges, CI runs and failures, tasks done) as telemetry traces over the last 13 completed days.
- Arabic and English, full RTL for the page.

Non-goals (this version):

- Sales, stores online, uptime over 30 days. Port has no data for them; the board says so ("not on the board yet").
- Writing anything to Port, Jira, Sentry or Datadog from the widget. It is read-only.
- Production data. The lab is the only environment today; the board says "Test lab, not real stores".
- 3D. Explored in mockups v3 and v4 and dropped by the owner in favour of the 2D control room.

Anti-goals (a failure even if it works):

- Showing anything as healthy when it is unknown. "No telemetry" is never green or calm (RT-617 boundary).
- Motion that does not come from data. No random particles presented as traffic.
- Decoration that makes a real fault harder to spot.
- Inventing a number. A missing figure is labelled missing.

## 3. Constraints

- **Port custom plugin.** A single self-contained `dist/index.html` in an iframe, React and TypeScript on `@port-labs/plugins-sdk`, built with webpack, uploaded with `@port-labs/port-plugins-cli` (repo skill `port-dashboard-plugins` is the reference). Data only from the Port REST API with the viewer's token (`PORT_TOKEN`, `PLUGIN_DATA`). No MCP at runtime.
- **CSP and bundling.** No CDN scripts or Google Fonts at runtime: Inter and IBM Plex Sans Arabic are bundled. No `innerHTML`; if a chart library pulls lodash, apply the skill's webpack shim.
- **Hooks before early returns** (blank iframe rule), loading, empty, error and stale states for every region.
- **Security.** Accept bridge messages only from the parent window; accept `baseUrl` only on https `port.io` or `getport.io` hosts (as in PR #556). Never log or render the token.
- **Repo rules.** The plugin lives at `tools/port-plugins/rt-control-room/`. `tools/**` is not a policy path, but a new `package.json` and lockfile are a dependency change: they need the owner's authorization in the RT issue and the `landing-gated-changes` skill applies.
- **Load on Port.** Poll every 60 seconds with filtered searches; stop polling and animation when the tab or tile is hidden; never refetch whole blueprints when a filter will do.

## 4. Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| 2D architecture map (v1, v2) | Clear and technical; felt flat | Kept as the base structure |
| 3D tower and stepped pyramid (v3, v4) | Impressive; lost the technical layer, heavy bundle, accessibility and flicker problems | Dropped by the owner |
| 2D control room with stations, cables and pinned alarms (v7 to v12) | Shows where faults come from; needs careful density | **Chosen** |

Finish: three styles were calibrated on one card (F1 telemetry, premium clean, industrial ISA-101). The owner chose **premium clean**. Colour discipline comes from ISA-101 high-performance HMI: normal is quiet grey, colour only for what is wrong or live. Telemetry traces come from the F1 reference.

## 5. What the board shows (decided)

Regions, top to bottom (see the mockup):

1. **Header.** Wordmark, "As of last sync HH:MM" (24-hour clock), scope chip "Test lab, not real stores", active alarm count, "Lab updated N ago", language toggle, light/dark, pause motion.
2. **Verdict.** One plain sentence generated from the data, plus three lights: Cashier app, Backend, Accounts. A line under it names what is not on the board yet.
3. **Telemetry, last 13 full days.** Today is partial and is neither drawn nor averaged. Four traces: changes merged per day, CI runs per day, CI failures per day (normal band 0 to 2, points above it in red), tasks done per day. Each has yesterday's value, a 13-day average, a shaded normal band (interquartile range, or 0 to 2 for failures), and a pulsing last point. One-day spikes are marked and explained as likely imports or cleanups, never hidden.
4. **Control room (the signature).**
   - **Control-room bar**: the four sources Port reads (Error tracker / Sentry, Health checks / Datadog, Code history / GitHub, Task tracker / Jira), each with its sync state and last change, and a signal bus every station rises to.
   - **Stations**: POS, Admin Console, Backend-Core, ERPNext-Connector, and ERPNext as an external ledger. Each has its plain role ("Where sales happen", "The brain", "The bridge to the accounts", "The books"), four link lamps (ERR, HLT with n/m, GIT, JIR), readings (alarms, health checks, CI pass 7d, open tasks, PRs, merged this week, deploys, CI fails 7d), and a merged-per-day mini bar chart.
   - **Cables**: Sales (POS to Backend-Core), Catalog (Admin to Backend-Core), Postings (Backend-Core to Connector), Invoices (Connector to ERPNext). Each tag shows what it carries and "no faults" or "N faults". A deliberate "no direct cable to ERPNext" path is drawn neutral as a protection, not as an error.
   - **Servers**: lab-01, lab-02, lab-03 under the stations they run, with their Datadog check counts; clickable for the list.
   - **Legend**: cable types, lamp letters, the alarm icon set, and a caption that motion means "the link is up", not sales traffic.
5. **Alarm panel.** Tabs: Alarms (count) and Events. Each alarm: icon, plain title, where ("On the cable Connector to ERPNext", "Inside Admin Console"), code, source, since. "No health check" items are listed as not faults, health unknown. Selecting an alarm dims everything unrelated, shows the request path with the failing hop, the original message, and a link to Sentry or Datadog.
6. **Lower panels.** Per station table (open tasks, PRs, CI runs, failed), Jira by status, CI last 72 runs strip with pass rate, Datadog health checks grouped by what they watch.

States and colours:

| State | Look |
|---|---|
| Normal or OK | Neutral grey, no colour |
| Live signal | The single accent (indigo), only on moving dots, traces and the bus |
| Fault | Red: station halo, faulted cable dashed and pulsing below 1 Hz, pinned alarm, red value |
| Stale or unknown | Amber chips, dashed outlines, "?" icon |
| Not needed | Muted text |

Alarm kinds (icon and motion are fixed):

| Kind | Source | Icon | Motion |
|---|---|---|---|
| Refused (403) | Sentry | Lock | A dot bounces back at a gate before ERPNext |
| Not answering (502) | Sentry | Unplugged | ERPNext fades to 25% and back |
| Took too long (timeout) | Sentry | Hourglass | A dot stalls and fades before arriving |
| Connection cut (reset) | Sentry | Cut cable | The cable opens a gap for one second |
| Code error | Sentry | Broken code | A scan line crosses the station |
| Slow responses (p95) | Datadog | Gauge | The station's cables slow down |
| Stopped reporting (no data) | Datadog | Flat heartbeat | The link lamp goes dashed amber |
| Any other monitor in Alert or Warn | Datadog | Bell | The station's halo turns red; no other motion |
| No health check | Datadog | Question mark | Static, listed as unknown |

Every alarm also sends a dot up the station's riser to its source on the bus. Unknown Sentry kinds fall back to "Code error".

Motion rules: motion only on a real change between two polls, or on replaying recent changes (labelled "Replaying recent changes (partial)"; see the replay rule below); nothing flashes faster than twice a second; Pause stops everything; reduced motion shows a still board. Riser dot speed follows each station's 7-day activity (CI runs plus merges).

Two modes (owner decision, 2026-11-13): a switch in the header, **Ops | Story**.

- **Ops** is the board as approved in mockup v13.
- **Story** is the same board, calmer, for visitors and investors. The verdict line is larger. Station readings, the per-station table and the lower panels are hidden; stations keep their name, role and state, and alarms keep their pins. A tour with Next, Previous and End steps through POS, Backend-Core, the bridge and ERPNext, with one plain sentence each in Arabic or English. It never advances on a timer.

Language: every string in both languages; `lang` and `dir` on the root; the diagram stays left to right in both; digits are Latin; Arabic text inside the diagram is pure Arabic or isolated.

Accessibility: stations, alarm pins and hosts are focusable buttons; Enter opens the detail and moves focus to its heading; Escape or Back returns focus to the element that opened the detail if it is visible, else to the pin with the same alarm id, else to the active tab button, never to the page body; one quiet `role="status"` announces only alarm changes, at most every 15 seconds; a table view exists for the map.

## 6. Data contract (Port, read-only)

| Element | Port source | Status today |
|---|---|---|
| Stations | `service` entities (`pos`, `admin-console`, `backend-core`, `erpnext-connector`), `runtime`, scorecard `observability_readiness` | Available |
| Open tasks per station | `jiraIssue` with `service` relation, status not Done | Available |
| PRs, merged this week | `githubPullRequest` with `service` relation, `mergedAt` | Available |
| CI 7d pass rate, fails | `service` aggregations `github_workflow_runs_7d`, `github_failed_workflow_runs_7d` | Available. Per-service run history starts 2026-11-11 |
| Deploys | `deployment` with `service` relation | Available. Most deployments have no service relation |
| Alarms from Sentry | `sentryIssue` (`status`, `isUnhandled`, title) to `workload` to `service` | Available. No count, first or last seen; kind comes from the title |
| Datadog checks | `datadogMonitor` (`overallState`) to `workload` to `service`; host-level monitors have no service | Available. Only Backend-Core is linked |
| Hosts | `datadogHost` (`up`) | Available |
| Source freshness | `GET /v1/integration` `resyncState`; newest `$updatedAt` per source blueprint | Available. Freshness is the newer of the two; a 403 or failure reads "unknown" |
| Telemetry traces | Daily counts from `githubPullRequest.mergedAt`, `githubWorkflowRun.createdAt` and `conclusion`, `jiraIssue.resolutionDate` | Available |
| Sales, stores online, uptime | None | Not available; shown as "not on the board yet" |

Port-side gaps, each a separate follow-up, not part of this build:

1. Sentry mapping: add `count`, `firstSeen`, `lastSeen` and a `kind` property to `sentryIssue`, and a project-level last event time, so "linked" can become "sending" honestly.
2. Datadog: link the Admin Console and ERPNext-Connector workloads to monitors, and add a "sends metrics" heartbeat for each.
3. Deployments: set the `service` relation on lab deployments.
4. A sales metric and an SLO in Datadog for the business tiles.

## 7. Decided by the builder (Claude's calls, marked)

- The Datadog "example alarm" button is a design aid. In production it is hidden behind `?demo=1` for presentations, labelled "example, not real" wherever it shows. (Claude's call.)
- Station positions are computed from a `tier` (front, core, integration, books) per service, so a fifth service needs data, not code edits. (Claude's call.)
- The cable list is derived from a small static architecture map in the plugin (the allowed paths are a rule, not data), plus faults from alarms. (Claude's call.)

## 7b. Rules settled after the builder check (Claude's calls)

- **Data layer.** First load fetches the 14-day window (13 completed days plus today) with filtered searches (date rules on `mergedAt`, `createdAt`, `resolutionDate`, paged), and the last 72 runs sorted by `createdAt`. Results are cached in memory; each 60-second poll fetches only entities with `$updatedAt` after the last poll and merges them; every fifth poll is a full poll in which the alarm blueprints (`sentryIssue` with status `unresolved`, `datadogMonitor`) REPLACE the cached collections, so resolved or deleted alarms disappear. A delta merges and never removes. A collection whose fetch failed or came back incomplete is "unchanged", never "empty": only a present result (including an empty one) is authoritative, so a failed read can never clear an alarm. A heavier first load is acceptable. A day is a Cairo calendar day (`Africa/Cairo`); the trace's last full day is "yesterday", today is shown as partial.
- **Verdict lights.** A light is red when its scope has an open alarm, amber when its health is unknown or a source is stale, and neutral (never green) when it has no alarm and is watched. Cashier app = POS (no Datadog by design, so it reads "No errors reported", never "healthy"); Backend = Backend-Core; Accounts = ERPNext-Connector plus the Invoices cable. The sentence is assembled from the three lights plus the scope ("in the test lab").
- **Alarm placement and kind.** Only `sentryIssue` with status `unresolved` counts. Kind comes from the title: `403` or `Forbidden` is Refused; `502`, `503` or `Bad Gateway` is Not answering; `Timeout` or `timed out` is Took too long; `reset` or `aborted` is Connection cut; anything else is Code error. An issue of the Connector whose title targets an ERPNext route (`/erpnext/`) is pinned on the Invoices cable; every other issue sits inside its station. The request path is the static allowed path up to that hop. Datadog monitors in `Alert`, `Warn` or `No Data` become alarms on the station they belong to. A monitor with no workload is placed on a host only when its title names one (`lab-03 Redis instance down`) or a `host:` tag does. Host identifiers are the Datadog host names `lab-01`, `lab-02` and `lab-03`, used unchanged everywhere; a host name outside that map is never coerced to a known host (none exists today; checked against Port on 2026-11-13); otherwise it is **unlocated** by design. The 8 host-pack monitors are multi-host (`{{host.name}}`) and Port does not say which host alerts, so they are counted, shown in the verdict and listed under "Not placed on the map", never pinned and never guessed.
- **Replay and Events.** Replay is a reconstruction, not a history: Port keeps no change log, so only entities that still exist and changed in the last 24 hours are animated once, in time order, under the chip "Replaying recent changes (partial)"; resolved Sentry issues and past monitor states cannot be replayed. After that only diffs between polls animate. `useBoard` exposes `replaying` and `onReplayDone()`, and the diagram calls it when the last replayed event finishes, is cancelled, or is skipped by reduced motion. The Events tab lists those entities newest first (merges, CI results, Jira status changes, new Sentry issues, monitor state changes). A monitor event that cannot be placed keeps its original title, carries an "Unlocated" label, is listed here and in the alarm panel under "Not placed on the map", and is never animated or given a station.
- **Servers and tiers.** A small static architecture map in the plugin holds each service's tier and each host's station (lab-01 and lab-02 to Backend-Core, lab-03 to ERPNext). A Port `tier` property is a later, optional improvement.
- **Freshness.** A source is fine when its newest change or completed sync is under 6 hours old, stale (amber) beyond that, unknown when the call fails or is forbidden. Whether normal viewers can read `/v1/integration` is checked early in the build; if not, freshness falls back to the newest `$updatedAt` only. "Sending" needs evidence (an event or a heartbeat monitor OK); "linked" means a project or workload relation exists with no evidence yet.
- **Fonts.** Inter (400, 500, 600) and IBM Plex Sans Arabic (400, 500), subset to Latin and Arabic ranges, inlined. The built file's size is reported in the evidence; target under 1.5 MB.
- **Identifiers.** Blueprint and relation names are constants with documented defaults; no upload params.
- **Missing values.** A reading with no data shows "no data", never 0.

## 8. Left to the builder

- React component split, state management, polling and diffing implementation.
- Exact geometry and responsive behaviour below 1200 px (the mockup stacks the alarm panel under the map).
- Chart rendering (SVG by hand or a small library, within the plugin skill's bundle rules).
- Test strategy: unit tests for data mapping and alarm classification, a Playwright check of the built `index.html` with a mocked Port API.

## 9. Verification and rollout

- Build and upload to Port as a new plugin `rt-control-room`, then add it to the Retail Tower Cockpit beside or in place of `ck_arch` (owner's choice at rollout).
- Evidence on the RT issue: built file size, upload result, a screenshot in Port in both languages, and one real alarm traced from Sentry to the board.

## 10. Design review (RT-1386 closeout): classification, previews and measurements

Reviewed on 2026-11-13 against mockup v13 (premium clean, unchanged). Previews live in the mockup behind `?proposals=1`; without that parameter the approved Ops view is visually identical (checked by screenshot, and by hashing the diagram, alarm list, verdict, telemetry and lower panels against the pre-review file: equal once host ids were normalized). Since that hash the markup changed in three ARIA attributes only (see the last paragraph) and the light-theme chip text colors. Nothing below is built until the owner approves it.

| # | Proposal | Class | In the mockup | Needs |
|---|---|---|---|---|
| 1 | Group the 4 pins on the Invoices cable into one count badge | Recommended visual enhancement | Specimen ("Pin grouping") | Owner decision: hides kinds until expanded |
| 2 | Progressive disclosure on station cards | Recommended visual enhancement | Not previewed | Owner decision: changes the approved card |
| 3 | Table view below about 900 px | Recommended visual enhancement | Live table ("Table view for narrow tiles") | Owner decision on the breakpoint |
| 4 | Story mode, manual tour | Owner decision required | Five-step tour | Owner approval of frames and copy |
| 5 | Loading, empty, stale, error states | Essential correction (a gap in "unknown is never healthy") | Four frames | Owner approval of the look; the rules are not optional |
| 6 | Unlocated alarms shown explicitly | Essential correction | Built. The example button "Example: an alarm Port cannot place" appears only with the previews, so the approved view is unchanged | None for the behavior |
| 7 | WCAG 2.2 AA contrast | Essential correction for two light-theme chip colors (applied, chip text only); owner decision for hairlines | Measured; chip text fixed | Owner decision on hairlines |

**Why 3 is not just polish.** The diagram is drawn on a 1240 px canvas. At 640 px it scales to about 0.46 and its 12 px labels render near 6 px (measured). At 900 px the scale is about 0.67 and 12 px labels render near 8 px (calculated from the layout). Below the breakpoint the table is the primary view; the alarm panel and verdict are unchanged. The table carries the same facts as the diagram: station, state, alarms, health checks, the four link states.

**Responsive layout proposed.**

| Tile width | Layout |
|---|---|
| 1200 px and up | Diagram and alarm panel side by side (as v13) |
| 900 to 1199 px | Diagram full width, alarm panel under it (as v13) |
| Below about 900 px | Table replaces the diagram; verdict lights in a row; telemetry two columns |
| 640 px and below | One column everywhere (as v13); the Story tour card sits above the table |

**Story mode storyboard (manual, nothing moves by itself).** The preview runs the tour over the Ops board (the calmer Story presentation in section 5, with a larger verdict and hidden readings, is still not mocked): one frame per step, Back, Next and Exit buttons, Escape exits, focus moves to Next on start. Stations and cables outside the frame dim to 30 percent. Text uses only facts already on the board; no frame invents a number. In the build every count (for example the 4 faults in step 5) is read from the board data; the mockup's 4 is the 2026-11-13 snapshot.

| Step | Highlight | Plain sentence (English; the Arabic is in the mockup) |
|---|---|---|
| 1 | Everything | Four Retail Tower products and one accounting system. Every link is drawn, and every fault is pinned where it happens. |
| 2 | POS, Admin Console, Sales and Catalog cables | Cashiers sell on the POS. Managers run stores in the Admin Console. Both talk only to Backend-Core. |
| 3 | Backend-Core and its three cables | Sales and catalog changes pass through Backend-Core. Nothing skips it on the way to the ledger. |
| 4 | Connector, ERPNext, Postings and Invoices | ERPNext is the accounting ledger, outside Retail Tower. Only the Connector may reach it. |
| 5 | Invoices cable | Where something is wrong, the board shows where it comes from: 4 faults on the invoice cable, reported by Sentry. What is not watched yet shows as unknown, never as healthy. |

**State rules (essential).** Red means a confirmed fault only. Amber means unknown, stale or missing monitoring. Neutral means watched and normal. No state ever reads green or healthy by default. Open conflict for the owner: RT-1386 and this rule say amber for unknown, but mockup v13 draws "no health check" and the Backend "Not sure" light in muted grey. The table preview follows the rule (amber). Decide whether v13 moves to amber or the rule moves to grey; the build follows the decision.

| State | What the board does |
|---|---|
| Loading | Placeholders only, no numbers, no colour; `aria-busy` on the panel |
| Empty | "No alarms", and stations with no health check still read unknown, so "no alarms" never means "all healthy" |
| Stale | Amber chip with the last sync time; the last good snapshot stays visible with its time on every panel |
| Error | Amber chip: the board cannot read Port; the last good snapshot stays; a failed read never clears an alarm; the board says alarms may be missing |

**Measured contrast (WCAG 2.2 AA; ratios computed from the rendered tokens, 2026-11-13).**

| Pair | Dark | Light | Need |
|---|---|---|---|
| Body text on card | 16.4 | 17.8 | 4.5 |
| Secondary text on card | 11.7 | 11.6 | 4.5 |
| Muted text (12 to 13 px notes, SVG labels) on card | 6.2 | 5.9 | 4.5 |
| Link blue on card | 6.6 | 5.7 | 4.5 |
| Fault red text on card | 6.3 | 5.3 | 4.5 |
| Red text on the red-soft chip | 5.3 | **4.50 (borderline; axe-core 4.10 flags it)** | 4.5 |
| Amber text on the amber-soft chip | 7.8 | **4.22 (fails)** | 4.5 |
| Focus ring, fault stroke vs card (graphics) | 6.6, 6.3 | 5.9, 5.3 | 3 |
| Station outline (`--color-rule-2`) vs card | 1.63 | 1.45 | 3 |
| Quiet live cable vs card | 1.44 | 1.36 | 3 |

Applied in the mockup and required in the build: in the light theme chip text uses `oklch(50% 0.14 70)` for amber (5.01) and `oklch(52% 0.19 28)` for red (5.11); the `--color-bad` and `--color-stale` tokens, and so every stroke and fill, are unchanged, and the dark theme needs no change. axe-core 4.10 then reports no violation in the approved view (both themes, EN and AR); it reports 190 to 290 text nodes as "incomplete" because of translucent backgrounds, so the ratios above are the contrast evidence. Owner decision: station outlines and the quiet live cable are below 3:1. They are decorative by the WCAG reading (every station and cable also has a text label and a state), and they are quiet by design in the ISA-101 direction (colour only for faults); raising them would make the approved look heavier.

**Corrections made in the mockup in this pass.** Keyboard focus returns only to a visible opener, never to the body or a stale one; three axe-core findings in the approved markup are fixed (`aria-pressed="null"` on alarm buttons, `role="img"` on a diagram that contains buttons, an unnamed role on the telemetry group); host ids use one form (`lab-01`); an alarm Port cannot place is counted, shown under "Not placed on the map" and in the Events tab with an "Unlocated" label, and is never pinned or animated; with an example showing, the verdict sentence and the Backend light no longer say "healthy" while an example fault or an unplaced alarm exists. This is the one visible change to the verdict wording, and only while an example is on.

Not recommended: more glow, nested cards, or motion without an event behind it.
