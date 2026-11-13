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
- Show the delivery pulse (merges, CI runs and failures, tasks done) as 14-day telemetry traces.
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
3. **Telemetry, last 14 days.** Four traces: changes merged per day, CI runs per day, CI failures per day (normal band 0 to 2, points above it in red), tasks done per day. Each has yesterday's value, a 14-day average, a shaded normal band (interquartile range, or 0 to 2 for failures), and a pulsing last point. One-day spikes are marked and explained as likely imports or cleanups, never hidden.
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

Motion rules: motion only on a real change between two polls, or on replaying the last 24 hours (labelled "Replaying"); nothing flashes faster than twice a second; Pause stops everything; reduced motion shows a still board. Riser dot speed follows each station's 7-day activity (CI runs plus merges).

Two modes (owner decision, 2026-11-13): a switch in the header, **Ops | Story**.

- **Ops** is the board as approved in mockup v13.
- **Story** is the same board, calmer, for visitors and investors. The verdict line is larger. Station readings, the per-station table and the lower panels are hidden; stations keep their name, role and state, and alarms keep their pins. A tour with Next, Previous and End steps through POS, Backend-Core, the bridge and ERPNext, with one plain sentence each in Arabic or English. It never advances on a timer.

Language: every string in both languages; `lang` and `dir` on the root; the diagram stays left to right in both; digits are Latin; Arabic text inside the diagram is pure Arabic or isolated.

Accessibility: stations, alarm pins and hosts are focusable buttons; Enter opens the detail and moves focus to its heading; Escape returns focus; one quiet `role="status"` announces only alarm changes, at most every 15 seconds; a table view exists for the map.

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

- **Data layer.** First load fetches the 14-day window with filtered searches (date rules on `mergedAt`, `createdAt`, `resolutionDate`, paged), and the last 72 runs sorted by `createdAt`. Results are cached in memory; each 60-second poll fetches only entities with `$updatedAt` after the last poll and merges them. A heavier first load is acceptable. A day is a Cairo calendar day (`Africa/Cairo`); the trace's last full day is "yesterday", today is shown as partial.
- **Verdict lights.** A light is red when its scope has an open alarm, amber when its health is unknown or a source is stale, and neutral (never green) when it has no alarm and is watched. Cashier app = POS (no Datadog by design, so it reads "No errors reported", never "healthy"); Backend = Backend-Core; Accounts = ERPNext-Connector plus the Invoices cable. The sentence is assembled from the three lights plus the scope ("in the test lab").
- **Alarm placement and kind.** Only `sentryIssue` with status `unresolved` counts. Kind comes from the title: `403` or `Forbidden` is Refused; `502`, `503` or `Bad Gateway` is Not answering; `Timeout` or `timed out` is Took too long; `reset` or `aborted` is Connection cut; anything else is Code error. An issue of the Connector whose title targets an ERPNext route (`/erpnext/`) is pinned on the Invoices cable; every other issue sits inside its station. The request path is the static allowed path up to that hop. Datadog monitors in `Alert`, `Warn` or `No Data` become alarms on the station they belong to, or on the host.
- **Replay and Events.** On load, entities created or updated in the last 24 hours are animated once, in time order, under the "Replaying" chip; after that only diffs between polls animate. The Events tab lists those entities newest first (merges, CI results, Jira status changes, new Sentry issues, monitor state changes).
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
