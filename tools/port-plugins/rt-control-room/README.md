# Retail Tower Control Room

A read-only custom widget for [Port](https://app.port.io) that draws the Retail Tower lab as a control room: the five stations, the cables between them, the servers, and every open alarm, built only from data Port already holds. It is a dashboard widget, not an entity-page widget, and it takes no plugin parameters. Jira key: RT-1381. Design: `docs/superpowers/specs/2026-11-13-rt-control-room-design.md`.

Status: built and unit-tested locally. It has not been uploaded to Port and has not run inside a real Port iframe (see "What has and has not been verified").

## Preview image

None is committed yet. Add `assets/preview.png` after the first render inside Port, and link it with the full GitHub blob URL as the Port template asks.

## What the board shows

Top to bottom:

1. **Header.** "As of last sync" time (24-hour), the scope chip "Test lab, not real stores", the active alarm count, "Lab updated N ago", the Ops / Story switch, EN / AR, light / dark and pause motion.
2. **Verdict.** One sentence generated from the data, three lights (Cashier app, Backend, Accounts) and a line naming what is not on the board yet (sales, stores online, uptime).
3. **Telemetry, 13 completed Cairo days.** Merged changes, CI runs, CI failures and tasks done per day. Today is partial and is neither drawn nor averaged. Each trace has yesterday's value, a 13-day average and a normal band; one-day spikes are marked, not hidden. A day is an `Africa/Cairo` calendar day.
4. **Control room.** A bar for the four sources (Sentry, Datadog, GitHub, Jira) with their sync state; the stations POS, Admin Console, Backend-Core, ERPNext-Connector and ERPNext (an external ledger), each with four link lamps (ERR, HLT, GIT, JIR) and readings; the cables Sales, Catalog, Postings and Invoices with their fault count; the servers lab-01, lab-02 and lab-03; and a legend.
5. **Alarm panel.** Tabs Alarms and Events. Selecting an alarm dims the rest, shows the request path with the failing hop, the original message and an https link to Sentry or Datadog. Monitors that cannot be placed are listed under "Not placed on the map" and never pinned.
6. **Lower panels.** Per-station table, Jira by status, the last 72 finished CI runs with the pass rate, and Datadog health checks grouped by what they watch.

**Modes.** *Ops* is the full board. *Story* is the same board, calmer, for visitors: a larger verdict, no readings table or lower panels, and a guided tour (Back, Next, Exit) that never advances on a timer. The tour's fault count is taken from the board data.

**Languages.** Every string exists in English and Arabic; `lang` and `dir` follow the choice, the diagram stays left to right, digits are Latin.

**Example alarm.** Adding `?demo=1` to the plugin's own URL shows a button that adds one Datadog "example" alarm, labelled "example, not real" wherever it appears. Only `window.location.search` is read, so a normal Port tile never shows it.

### Alarm placement (2026-11-13 snapshot: 3 + 1 + 1)

Only Sentry issues with `status = unresolved` count. On the 2026-11-13 snapshot (the test fixture) there are 5 alarms: **3 on the Invoices cable** (403, ConnectTimeout, 502), **1 inside the ERPNext-Connector** (the ConnectionResetError) and **1 inside Admin Console**. The rule: an issue of the Connector is pinned to the Invoices cable only if its title names an `/erpnext/` route; every other issue sits inside its station. A route is never invented to make a count. The Connector station's own alarm reading therefore shows 4 (the 3 on its cable plus the 1 inside), while the cable shows 3 faults.

Datadog monitors in Alert, Warn or No Data become alarms on the station of their workload. A monitor with no workload goes on a host only when its title or a `host:` tag names exactly one known host; otherwise it is "not placed", by design.

### Honest-unknown rules

- Unknown is never green. A light is red with an open alarm, amber when its health is unknown or a source is stale, and neutral (never "healthy") when it has no alarm and is watched. The POS has no Datadog by design, so it reads "No errors reported".
- A reading with no data shows "no data", never 0.
- A collection whose read failed or came back incomplete is "unchanged", never "empty". Only a present result (including an empty list) is authoritative.
- **Failed Sentry read (acceptance criterion 7).** When the `sentryIssue` read fails or has never succeeded, every station's alarm reading is "not read" (never "none reported" or 0), and a failed read never clears an alarm already on the board. Resolved or deleted issues disappear only on a successful full poll.
- A source is fresh when its newest change or completed sync is under 6 hours old, stale (amber) beyond that, and unknown when the call fails or is forbidden. "Sending" needs evidence; "linked" means a relation exists with no evidence yet.

## Data contract (Port, read-only)

All reads are `POST /v1/blueprints/{blueprint}/entities/search` with the body nested under `query` (cursor paging via `from`, 1000 per page), plus one `GET /v1/integration`. Blueprint names are constants in `src/state/blueprints.ts`; `WINDOW` is the 14-day window `now - 14 x 24 h` to `now`, which covers 13 completed Cairo days plus today.

| Board element | Blueprint | Query sent | First load / full poll | Delta poll |
|---|---|---|---|---|
| Stations, runtime, CI 7d pass rate and fails (service aggregations `github_workflow_runs_7d`, `github_failed_workflow_runs_7d`) | `service` | all (`rules: []`) | read, replaces | read in full, replaces |
| Workload to service link | `workload` | all | read, replaces | read in full, replaces |
| Servers | `datadogHost` | all | read, replaces | read in full, replaces |
| Source freshness | `GET /v1/integration` (`resyncState`) | none | read, replaces | read in full, replaces |
| Alarms from Sentry | `sentryIssue` | `status = unresolved` | read, replaces (resolved issues drop out) | adds `$updatedAt between since..now`, merged by `identifier` |
| Datadog checks | `datadogMonitor` | all | read, replaces | adds `$updatedAt between`, merged |
| Open tasks, Jira by status, tasks done | `jiraIssue` | all, narrowed on the client to issues with a `service` relation, minus Done issues resolved before the window | read, replaces | adds `$updatedAt between`, merged |
| PRs, merged this week, merged per day | `githubPullRequest` | `mergedAt between WINDOW` | read, merged | adds `$updatedAt between` |
| Last 72 finished runs and pass rate, CI runs and failures per day | `githubWorkflowRun` | `createdAt between WINDOW` | read, merged | adds `$updatedAt between` |
| Deploys | `deployment` | `createdAt between WINDOW` | read, merged | adds `$updatedAt between` |

Notes on the table:

- **Poll cadence.** The first load is poll 1 and is full; then one poll every 60 seconds, and every fifth poll (5, 10, ...) is full. The others are deltas. A collection never read successfully always gets a full or window fetch, never a delta. A delta merges by `identifier` and never removes anything.
- **Paused when hidden.** Polling stops while the tab or iframe is hidden and resumes when it is visible again. It also waits for a trusted base URL and a token.
- **Why the filters are small.** Only rule shapes that Port documents (the empty group, `between` on a date, `=` on a property) are sent. Anything else (set tests, `notIn`, nested groups) is filtered on the client, because a 422 on an unproven shape would keep the board stale.
- **CI figures.** The per-station CI pass rate and fails come from the `service` aggregations; the 72-run strip and the daily traces come from the windowed runs. Per-service run history in Port starts 2026-11-11.
- **Jira.** The first load and every full poll read every issue (paged), so an open issue untouched for months still counts.

What Port holds today for each element, and what is missing:

| Element | Status today |
|---|---|
| Alarms from Sentry | Available. No count, first or last seen; the kind comes from the issue title |
| Datadog checks | Available. Only Backend-Core is linked to monitors; the 8 host-pack monitors are multi-host and cannot be placed |
| Deploys | Available. Most deployments have no `service` relation |
| Source freshness | Available when `GET /v1/integration` is readable; a 403 or failure reads "unknown" and falls back to the newest `$updatedAt` |
| Sales, stores online, uptime | None. Shown as "not on the board yet" |

### Port-side gaps (separate follow-ups, not part of this build)

1. Sentry mapping: add `count`, `firstSeen`, `lastSeen` and a `kind` property to `sentryIssue`, and a project-level last event time, so "linked" can become "sending" honestly.
2. Datadog: link the Admin Console and ERPNext-Connector workloads to monitors, and add a "sends metrics" heartbeat for each.
3. Deployments: set the `service` relation on lab deployments.
4. A sales metric and an SLO in Datadog for the business tiles.

## Security

- **Trusted base URL gate.** The Port API base URL sent by the host is parsed, not pattern-matched: it must be `https`, with no credentials and no custom port, on `port.io`, `getport.io` or a subdomain of either. Anything else shows an "untrusted" message and the token is withheld, so it can never be sent to another host.
- **Bridge messages.** The widget talks to Port only through `@port-labs/plugins-sdk`, which accepts messages from `window.parent` only. The one message the widget sends itself is a data-free `REQUEST_PORT_TOKEN` to the parent, after a 401.
- **Links.** Sentry and Datadog links come from the entity's `link` property and are rendered only when the scheme is `https`, with `rel="noopener noreferrer"`. The widget draws no Port portal links.
- **No token exposure.** The token is never logged, put in a query key, rendered or stored. API errors carry the HTTP status only, never a response body.
- **Read-only.** Only `POST .../entities/search` (a read) and `GET /v1/integration` are called. No writes, no actions.
- **Safe rendering.** React text only. `npm run check` fails the build if `src/` contains `innerHTML`, `outerHTML` or `dangerouslySetInnerHTML`. No CDN and no Google Fonts: Inter and IBM Plex Sans Arabic are inlined.

## Prerequisites

- A Port account that can add custom widgets and read the blueprints above (`service`, `workload`, `datadogHost`, `sentryIssue`, `datadogMonitor`, `jiraIssue`, `githubPullRequest`, `githubWorkflowRun`, `deployment`) and, for freshness, `GET /v1/integration`.
- Node.js 20 or later (see `package.json` `engines`).
- No new blueprints, relations or automations. `upload-params.json` is `{}`.

## Local development

```bash
npm ci
npm run dev     # http://localhost:9000
npm test        # vitest, jsdom
npm run build   # production build, output dist/index.html
npm run check   # dist is within the size budget and self-contained; src has no forbidden HTML APIs
```

Outside Port there is no token, so the board shows the "waiting for Port" state; use Port's local-development iframe or the fixture-driven tests to see data.

## Upload (owner-authorized only, NOT yet run)

Do not run this without the owner's authorization. Credentials come from the environment as the CLI documents (`PORT_CLIENT_ID`, `PORT_CLIENT_SECRET`); they are never written to this repository.

```bash
# from tools/port-plugins/rt-control-room/
npx port-plugins upload --file dist/index.html --identifier rt-control-room --title "Retail Tower Control Room" --params "{}" --description "Live control room of Retail Tower services, cables and alarms" --upsert
```

Then add it in Port: dashboard, **Add widget**, **Custom widget**, **Retail Tower Control Room**. Whether it sits beside or replaces the `ck_arch` widget is the owner's rollout decision.

## What has and has not been verified

Done, locally:

- Unit and component tests with Vitest and jsdom, including the 2026-11-13 snapshot fixture, the 3 + 1 + 1 placement, the failed-Sentry "not read" case, the trust gate, and an identical hook count before and after the token arrives.
- `npm run check` on the build (size budget, no forbidden HTML APIs).

Not done:

- No live Port query has been made: the `between` and `$updatedAt` rule bodies are written to Port's documented shapes but are unproven against the real API.
- A viewer-level `GET /v1/integration` check (200 or 403) is pending, and must be recorded before any non-admin rollout. Until then freshness for non-admins may fall back to the newest `$updatedAt`.
- Nothing has run inside a real Port iframe, in either language or mode, and no Sentry alarm has been traced end to end to its pin.
- The widget has not been uploaded.

## Versions

- `@port-labs/plugins-sdk` is declared `^0.1.0` (the template's range) and the lockfile resolves 0.1.1. `npm view @port-labs/plugins-sdk version` returned 0.4.0 on 2026-11-14. No upgrade has been done; it is a separate decision.
- Built from the Port template pack `port-labs/port-skills` at commit `fb55927d2f46095d93d5fd9d684eced800c48d90`.
- Plugin version 0.1.0.

## Relation to `rt-architecture-map`

`tools/port-plugins/rt-architecture-map/` is untouched. The Control Room is a separate plugin (`rt-control-room`); replacing the `ck_arch` widget with it is the owner's rollout decision.

## Project structure

```
rt-control-room/
  src/
    api/          # read-only Port client (search, GET), status-only errors
    bridge/       # SDK wrapper, trusted-base-URL gate, token re-request
    model/        # pure data to board: alarms, stations, lamps, verdict, telemetry, freshness
    state/        # blueprints, queries, merge, diff, events, poller, useBoard
    components/   # header, verdict, telemetry, room/ (SVG board), panels, tour
    i18n/         # English and Arabic strings
    styles/       # tokens and CSS
  scripts/        # check-dist.mjs, check-src.mjs
  dist/index.html # committed upload artifact
  upload-params.json
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Untrusted" message | The host sent a base URL outside port.io or getport.io | Open the widget from Port itself; check the regional Port URL |
| "Waiting for Port" | Opened outside Port, or the token has not arrived | Embed through Port or its local-development iframe |
| Station alarms read "not read" | The `sentryIssue` read failed or was forbidden | Check the viewer's access to the `sentryIssue` blueprint; existing alarms stay on the board |
| Source chips read "unknown" | `GET /v1/integration` is forbidden for this viewer | Expected for non-admins; freshness falls back to the newest change |
| Board stops updating | The tab is hidden, or a read keeps failing | Polling resumes when visible; a failed read keeps the last good data |
