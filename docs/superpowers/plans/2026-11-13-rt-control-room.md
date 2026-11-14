# Retail Tower Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Retail Tower Control Room as a read-only Port custom plugin (`rt-control-room`) that draws every service as a station, every link as a labelled cable, and every Sentry or Datadog fault as an alarm pinned where it happens.

**Architecture:** A React + TypeScript app compiled by webpack into one self-contained `dist/index.html`. A pure model layer turns Port API entities into a `Board` (stations, cables, alarms, lamps, telemetry, verdict); a polling hook keeps a cached snapshot fresh every 60 s and emits change events; presentational components draw the board as HTML panels plus one SVG diagram, in Arabic or English, in Ops or Story mode.

**Tech Stack:** React 19, TypeScript 5, `@port-labs/plugins-sdk`, `@tanstack/react-query` 5, webpack 5 (template from the `port-dashboard-plugins` skill), `@fontsource/inter` and `@fontsource/ibm-plex-sans-arabic` (subset woff2 inlined), Vitest + Testing Library + jsdom for tests.

**Spec:** [docs/superpowers/specs/2026-11-13-rt-control-room-design.md](../specs/2026-11-13-rt-control-room-design.md). The approved look and every behaviour are in the mockup [2026-11-13-rt-control-room-mockup.html](../specs/2026-11-13-rt-control-room-mockup.html): copy its CSS tokens, layout coordinates, icon paths and copy (both languages) instead of re-inventing them.

## Global Constraints

- Location: `tools/port-plugins/rt-control-room/`. The new `package.json` and `package-lock.json` are a dependency change: the RT issue must authorize them; apply the `landing-gated-changes` skill.
- Read-only: the widget never writes to Port, Jira, Sentry or Datadog.
- Data only from the Port REST API with the viewer's token. No MCP, no CDN, no Google Fonts at runtime. No `innerHTML`, `outerHTML` or `dangerouslySetInnerHTML`.
- Bridge messages accepted only from `window.parent`; `baseUrl` accepted only when https and the host is `port.io`, `getport.io` or a subdomain of either. Never log or render the token.
- Poll every 60 s; stop polling and animation when the document is hidden or the tile is off-screen.
- Unknown is never green or "Calm". A missing figure shows "no data", never 0.
- Colours: neutral for normal, the single accent (indigo) only for live signal, red only for faults, amber only for stale or unknown.
- Motion only on a real change between polls or the labelled 24 h replay; nothing flashes faster than 2 Hz; Pause and `prefers-reduced-motion` stop all of it.
- Every string exists in English and Arabic; `<html lang dir>` follows the language; Latin digits; 24-hour clock; day boundaries in `Africa/Cairo`.
- Built file target under 1.5 MB; `dist/index.html` is committed (generated code: the RT issue authorizes it).
- Git: the plugin has its own `.gitignore` (`node_modules/`, `coverage/`, `dist/*`, `!dist/index.html`). Stage named files only (CLAUDE.md §11), never the folder, and check `git status --short` before each commit.
- CI: `tools/**` selects every job (`graph.yaml` `tooling`), so commit per task locally and push once, at the end (CLAUDE.md §11 step 2). PR title carries `[GATED: deps/lockfile]` (`landing-gated-changes`).

## Step 0 (before Task 1)

- [ ] Name the RT issue and confirm it authorizes: the new `package.json` and `package-lock.json` with exactly the dependencies listed in Task 1, the committed generated `dist/index.html`, and the Port upload in Task 12. Commits below use the key `RT-1381`; if the owner moves the work to another issue, replace it. Stop if any of these is not authorized.

## Review Focus

1. A service entity is missing from Port, or a relation is empty: the station still draws, readings show "no data", no crash.
2. The viewer cannot read `GET /v1/integration` (403): source freshness falls back to newest `$updatedAt`; nothing turns green by default.
3. A day with hundreds of CI runs (480 seen on 2026-11-12): paged fetch completes, traces cap and mark the spike, the UI does not freeze.
4. The token expires mid-session (401 on a poll): one token request, the last good board stays on screen with a stale chip.
5. The tile is short (Port tile height, not the window): the layout scrolls inside the tile and the diagram keeps its aspect ratio.

---

### Task 1: Scaffold, build pipeline, fonts and tokens

**Files:**
- Create: `tools/port-plugins/rt-control-room/{.gitignore,package.json,package-lock.json,tsconfig.json,webpack.config.js,vitest.config.ts,upload-params.json,README.md}`
- Create: `tools/port-plugins/rt-control-room/src/{index.html,index.tsx,App.tsx,styles/tokens.css,styles/app.css}`
- Create: `tools/port-plugins/rt-control-room/webpack/lodash-root-shim.js` only if a dependency pulls lodash
- Test: `src/__tests__/App.test.tsx`, `scripts/check-dist.mjs`

**Interfaces:**
- Produces: `App` (default export of `src/App.tsx`), CSS custom properties from the mockup's `:root` and `[data-theme="light"]` blocks in `styles/tokens.css`.

- [ ] **Step 1:** The scaffold templates come from Port's skill pack, not from this repository: `.claude/skills/port-*` is not tracked here. Install it once with `npx skills add port-labs/port-skills --skill "*" -a claude-code -y` (repo `github.com/port-labs/port-skills`, MIT), which creates untracked files under `.claude/skills/` and a `skills-lock.json` entry; never commit them. Record the pack's commit (from `skills-lock.json` or `gh api repos/port-labs/port-skills/commits/main --jq .sha`) on the RT issue as the template version. The templates are in `.claude/skills/port-dashboards/port-dashboard-plugins/assets/`: `template-webpack.config.js`, `template-tsconfig.json`, `template-index.html`, `template-index.tsx`, `template-package.json`, `template-usePostMessageData.ts`, `template-App.tsx`, `template-App.css`, plus `assets/webpack/`. Copy them into the plugin folder (package name `port-rt-control-room-plugin`, version `0.1.0`). If the pack cannot be installed, copy the same files from `github.com/port-labs/port-skills/tree/main/skills/port-dashboards/port-dashboard-plugins/assets`. This is the complete dependency list the RT issue authorizes. From the template (verified 2026-11-13): dependencies `@port-labs/plugins-sdk ^0.1.0`, `@tanstack/react-query ^5.95.0`, `react ^19.0.0`, `react-dom ^19.0.0`; devDependencies `@types/react`, `@types/react-dom`, `css-loader`, `html-webpack-plugin`, `postcss`, `postcss-loader`, `postcss-preset-env`, `react-dev-utils`, `style-loader`, `terser-webpack-plugin`, `ts-loader`, `typescript`, `webpack`, `webpack-cli`, `webpack-dev-server`. Added by this plan: dependencies `@fontsource/inter`, `@fontsource/ibm-plex-sans-arabic`; devDependencies `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@port-labs/port-plugins-cli`. Scripts: `build`, `dev`, `test` (`vitest run`), `check` (`node scripts/check-dist.mjs && node scripts/check-src.mjs`). `vitest.config.ts` uses `environment: "jsdom"`. Webpack: add `{ test: /\.woff2$/, type: "asset/inline" }`. `upload-params.json` is `{}`. `.gitignore` as in Global Constraints.
- [ ] **Step 2: Write the failing test** `App.test.tsx`: `render(<App />)` with no bridge data shows the text `Waiting for Port...`.
- [ ] **Step 3:** Run `npx vitest run`. Expected: FAIL (App not found).
- [ ] **Step 4:** Implement `App` with the template's hook order and guard messages; import tokens and fonts (Inter 400/500/600 latin, IBM Plex Sans Arabic 400/500 arabic).
- [ ] **Step 5:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 6:** Write `scripts/check-dist.mjs`: fail if `dist/index.html` is over 1,572,864 bytes, contains `Function(` or `fonts.googleapis`, or contains any `https?://` URL outside an allowlist (`www.w3.org`, `reactjs.org`, `react.dev`). Write `scripts/check-src.mjs`: fail if any file under `src/` contains `innerHTML`, `outerHTML` or `dangerouslySetInnerHTML` (react-dom itself contains `innerHTML`, so this check runs on the source, not on `dist`). Run `npm run build && npm run check`. Expected: `dist ok <size>` and `src ok`.
- [ ] **Step 7:** Stage by name (`.gitignore`, `package.json`, `package-lock.json`, configs, `src/`, `scripts/`), check `git status --short` shows no `node_modules` or `dist/ui.js`, commit `feat: RT-1381 scaffold the rt-control-room Port plugin`.

### Task 2: Port bridge and API client

**Files:**
- Create: `src/bridge/usePortBridge.ts`, `src/api/portClient.ts`
- Test: `src/bridge/__tests__/usePortBridge.test.ts`, `src/api/__tests__/portClient.test.ts`

**Interfaces:**
- Produces: `usePortBridge(): { token: string | null; baseUrl: string | null; applyThemeCss(): void; trusted: boolean }`, a thin wrapper over the SDK's `usePortPluginData()` that keeps its token refresh and `applyThemeCss`, and returns `baseUrl: null, trusted: false` when `isTrustedBaseUrl` rejects the host (the App then shows "Untrusted Port API host"). Do not hand-roll the postMessage protocol. `isTrustedBaseUrl(url: string): boolean`; `createPortClient(baseUrl: string, getToken: () => string | null, onUnauthorized: () => void)` returning `{ search<T>(blueprint: string, query: PortQuery, opts?: { limit?: number; include?: string[] }): Promise<T[]>; get<T>(path: string): Promise<T> }`; `PortQuery = { combinator: "and" | "or"; rules: PortRule[] }`.

- [ ] **Step 1: Write failing tests:** `isTrustedBaseUrl` true for `https://api.getport.io`, `https://api.port.io`, `https://api.us.port.io`; false for `http://api.getport.io`, `https://getport.io.evil.com`, `https://evil.com`. With the SDK hook mocked to return an untrusted `portApiBaseUrl`, `usePortBridge` returns `trusted: false`. `search` follows `next` cursors until absent, sending each one back as `from`, and concatenates entities; sends the body nested under `query`; a 401 calls `onUnauthorized` exactly once and rejects with `Unauthorized`.
- [ ] **Step 2:** Run `npx vitest run src/bridge src/api`. Expected: FAIL.
- [ ] **Step 3:** Implement. `search` posts to `/v1/blueprints/{bp}/entities/search` with `{ query, limit: opts.limit ?? 1000, include, from }` and loops on `next`. Update Task 1's `App.test.tsx` to mock `usePortBridge`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: RT-1381 Port bridge and paged API client`.

### Task 3: Architecture map and alarm model

**Files:**
- Create: `src/model/types.ts`, `src/model/architecture.ts`, `src/model/alarms.ts`
- Test: `src/model/__tests__/alarms.test.ts`

**Interfaces:**
- Produces: raw entity types with the keys from spec §6: `PortEntity<P, R> = { identifier: string; title: string; properties: P; relations: R; createdAt: string; updatedAt: string }`; `ServiceEntity`, `WorkloadEntity` (relations `service`, `sentry_project`, `datadog_service`), `SentryIssue` (properties `status`, `isUnhandled`, `link`; relation `workload`), `DatadogMonitor` (properties `overallState`, `link`; relation `service` → workload id), `DatadogHost` (`up`, `host_name`), `JiraIssue` (`status`, `resolutionDate`; relation `service`), `PullRequest` (`status`, `mergedAt`; relation `service`), `WorkflowRun` (`conclusion`, `createdAt`; relation `service`), `Deployment` (relation `service`), `Integration` (`installationId`, `integrationType`, `resyncState.lastResyncEnd`, `resyncState.status`); `Snapshot = { services; workloads; sentryIssues; monitors; hosts; jira; prs; runs; deployments; integrations: Integration[] | "forbidden"; fetchedAt: string }`, and `Collection = Exclude<keyof Snapshot, "fetchedAt">` (the type that `fetchSnapshot` and `mergeSnapshot` name; never a Port blueprint ID). Types `StationId = "pos" | "admin" | "core" | "conn" | "erp"`, `CableId = "c1" | "c2" | "c3" | "c4"`, `AlarmKind = "refused" | "down" | "timeout" | "reset" | "bug" | "latency" | "nodata" | "monitor"`, `HostId = "lab-01" | "lab-02" | "lab-03"` (the Datadog `host_name` exactly as Port stores it, used unchanged in `ARCH`, `Alarm.at` and `HostView.id`; there is no normalization step), `AlarmAt = StationId | CableId | HostId | "unlocated"`, `Alarm = { id: string; kind: AlarmKind; source: "Sentry" | "Datadog"; station: StationId | null; at: AlarmAt; title: string; message: string; since: string | null; link: string | null; example?: boolean }`. `DatadogMonitor` also reads `title` and `properties.tags: string[]`. Verified read-only against Port on 2026-11-13: none of the 18 monitors carries a `host:` tag. Three name their host in the title (`lab-02 Postgres connections...`, `lab-03 Redis instance down`, `lab-03 MariaDB connections...`); the 8 host-pack monitors (tags `integration:host`, titles with `{{host.name}}`) are one multi-host monitor each and Port does not say which host is alerting. `ARCH` in `architecture.ts`: stations with `serviceId` (`pos`, `admin-console`, `backend-core`, `erpnext-connector`), `tier`, roles in both languages, the 4 cables (`c1` pos→core Sales, `c2` admin→core Catalog, `c3` core→conn Postings, `c4` conn→erp Invoices), `PATH = ["pos","core","conn","erp"]`, hosts (`lab-01`→core, `lab-02`→core, `lab-03`→erp). Functions `classifySentryKind(title: string): AlarmKind`, `placeSentryAlarm(station: StationId, title: string): StationId | CableId`, `sentryAlarms(issues: SentryIssue[], workloadToService: Map<string, string>): Alarm[]`, `datadogAlarms(monitors: DatadogMonitor[], workloadToService: Map<string, string>): Alarm[]`.

- [ ] **Step 1: Write failing tests** with the real titles from the mockup's `ALARMS`: the 403 title → `refused` at `c4`; the ConnectTimeout title → `timeout` at `c4`; the 502 Bad Gateway title → `down` at `c4`; the ConnectionResetError title → `reset` at `c4`; the React title on admin → `bug` at `admin`; an unknown title → `bug` inside its station; a `resolved` issue → no alarm. Datadog mapping for monitors in `Alert`, `Warn` or `No Data` (`OK` gives none): title contains `latency` or `p95` → `latency`; state `No Data` → `nodata`; any other → `monitor` (its own icon: a bell). Workload `retail-tower-backend-api-staging` and `retail-tower-backend-worker-staging` map to `backend-core`; a monitor with no workload whose title contains `lab-02` or `lab-03` (or that has a tag `host:lab-0N`, should Port add one) is placed at that host (`lab-03` → `at: "lab-03"`, its `station` is `erp`); any other monitor with no workload, including the 8 host-pack monitors, gets `at: "unlocated"` and `station: null` by design: it is counted and listed in the alarm panel under "Not placed on the map", never pinned and never guessed onto a host. A host name that is not in `ARCH` (for example `lab-04 CPU high`) is never coerced to a known host: the alarm is `unlocated` and no host is drawn. `ARCH.hosts` is typed `Record<HostId, StationId>`. Tests: `lab-03 Redis instance down` in Alert → `at: "lab-03"`; `lab-04 CPU high` and `CPU usage is high for host {{host.name}}` in Alert → `unlocated`; the `ARCH` host keys, `HostView.id` and `Alarm.at` for hosts all equal the Datadog `host_name` of the fixture hosts (no conversion in any test). Build `src/model/__tests__/fixtures/snapshot-2026-11-13.json` from raw Port entities (the 4 services, 5 workloads, 5 Sentry issues, 18 monitors, 5 hosts, and Jira, PR and run samples), not from the mockup's board data.
- [ ] **Step 2:** Run `npx vitest run src/model`. Expected: FAIL.
- [ ] **Step 3:** Implement the rules from spec section 7b ("Alarm placement and kind"), case-insensitive regexes.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: RT-1381 architecture map and alarm classification`.

### Task 4: Freshness and link lamps

**Files:**
- Create: `src/model/freshness.ts`, `src/model/lamps.ts`
- Test: `src/model/__tests__/freshness.test.ts`, `src/model/__tests__/lamps.test.ts`

**Interfaces:**
- Produces: `SourceId = "sentry" | "datadog" | "github" | "jira"`; `sourceFreshness(args: { lastSync: string | null; newestChange: string | null; integrationForbidden: boolean; now: Date }): { state: "fresh" | "stale" | "unknown"; lastChange: string | null; lastSync: string | null }`; `LinkState = "sending" | "live" | "linked" | "none" | "na" | "alert"`; `stationLamps(station: StationId, evidence: LampEvidence): Record<SourceId, { state: LinkState; checks?: { ok: number; total: number } }>`.

- [ ] **Step 1: Write failing tests:** newest of sync and change under 6 h → `fresh`; 6 h 1 min → `stale`; both null → `unknown`; forbidden with a change 1 h old → `fresh`, with nothing → `unknown`. Lamps: POS Datadog → `na`; Admin and Connector Datadog with no monitors → `none`; Core Datadog with 7 monitors all OK → `sending` with `7/7`; one in Alert → `alert` with `6/7`; Sentry with a project and an issue → `sending`; with a project and no issue → `linked`; GitHub and Jira with any linked entity → `live`.
- [ ] **Step 2:** Run `npx vitest run src/model`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: RT-1381 source freshness and link lamps`.

### Task 5: Telemetry series

**Files:**
- Create: `src/model/telemetry.ts`
- Test: `src/model/__tests__/telemetry.test.ts`

**Interfaces:**
- Produces: `dailySeries(timestamps: string[], now: Date, days = 14): number[]` (Cairo days, oldest first, 14 values: 13 completed days plus today, which is partial); `completedDays(series: number[]): number[]` (drops today); `traceStats(completed: number[], kind: "count" | "failures"): { yesterday: number; average: number; band: [number, number]; cap: number; spikes: number[] }`, taking the 13 completed days only, where `average` is their mean (labelled "13-day avg"), `yesterday` is the last value, `band` is their interquartile range or `[0, 2]` for failures, and `spikes` are indexes above `max(3 × median, 80th percentile, 1)`. Today is never drawn or averaged.

- [ ] **Step 1: Write failing tests.** Cairo day boundaries, winter (UTC+2): `2026-11-12T21:59:59Z` is 12 Nov and `2026-11-12T22:00:00Z` is 13 Nov. Summer (UTC+3, Egypt DST): `2026-07-15T20:59:59Z` is 15 Jul and `2026-07-15T21:00:00Z` is 16 Jul. The mockup series `[11,13,3,11,12,26,26,20,61,48,54,132,480,0]` is 14 values; `completedDays` returns the first 13; `traceStats` gives `yesterday` 480, `average` 69.0 (rounded to one decimal) and `spikes` containing indexes 11 and 12; failures `[2,2,0,1,2,0,1,1,2,0,1,3,2]` give band `[0,2]` and a mean of 1.3.
- [ ] **Step 2–4:** Run (FAIL), implement with `Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" })`, run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 telemetry series over 13 completed days`.

### Task 6: Verdict and board assembly

**Files:**
- Create: `src/model/verdict.ts`, `src/model/board.ts`
- Test: `src/model/__tests__/verdict.test.ts`, `src/model/__tests__/board.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: view types (each a plain object the components render, defined in `src/model/types.ts`): `StationView = { id: StationId; name: string; role: I18n; lamps: Record<SourceId, Lamp>; readings: { alarms: number; checks: { ok: number; total: number } | "na" | null; ci7d: number | null; tasks: number | null; prs: number | null; merged7d: number | null; deploys: number | null; ciFails7d: number | null }; merged13d: number[]; activity7d: number }`, `CableView = { id: CableId; from: StationId; to: StationId; carries: I18n; state: "live" | "fault"; faults: number }`, `SourceView = ReturnType<typeof sourceFreshness> & { id: SourceId }`, `TraceView = { key: "merged" | "runs" | "fails" | "done"; series: number[] } & ReturnType<typeof traceStats>`, `HostView = { id: HostId; station: StationId; up: boolean | null; checks: { ok: number; total: number } }`, `PerStationRow = { station: StationId; tasks: number | null; prs: number | null; runs: number | null; failed: number | null }`, `I18n = { en: string; ar: string }`. `buildBoard(snapshot: Snapshot, opts: { now: Date; demo: boolean }): Board` where `Board = { stations: StationView[]; cables: CableView[]; alarms: Alarm[]; unknowns: { station: StationId; reason: "no-health-check" }[]; sources: Record<SourceId, SourceView>; telemetry: TraceView[]; verdict: Verdict; hosts: HostView[]; perStation: PerStationRow[]; jira: Record<"todo" | "inProgress" | "review" | "done", number>; ci: { last72: ("s" | "f" | "c" | "k")[]; passRate: number | null } }`; `Verdict = { lights: { cashier: Light; backend: Light; accounts: Light }; sentence: { en: string; ar: string } }`, `Light = { tone: "fault" | "unknown" | "neutral"; text: { en: string; ar: string } }`.

- [ ] **Step 1: Write failing tests:** the raw Port entity fixture `src/model/__tests__/fixtures/snapshot-2026-11-13.json` created in Task 3 (reuse it; do not build another from the mockup's board data) yields 5 alarms, `unknowns` = admin and conn, cable `c4` state `fault` with 4 faults, accounts light `fault`, backend light `neutral` with text "7 of 7 checks OK", cashier light `neutral` with "No errors reported"; with Core's monitors removed the backend light is `unknown`, never `neutral`; a station whose service entity is missing has readings `null` ("no data"); `demo: true` adds the example latency alarm flagged `example`. Unlocated alarms are never invisible: an untagged host-pack monitor in Alert raises the header alarm count, turns the Backend and Accounts lights no better than `unknown` (an alarm that cannot be placed is not evidence of health) and adds a clause to the verdict sentence ("1 alarm could not be placed on the map").
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 verdict and board model`.

### Task 7: Data layer, polling and change events

**Files:**
- Create: `src/state/fetchSnapshot.ts`, `src/state/useBoard.ts`, `src/state/diff.ts`
- Test: `src/state/__tests__/useBoard.test.tsx`, `src/state/__tests__/diff.test.ts`

**Interfaces:**
- Consumes: `createPortClient` (Task 2), `buildBoard` (Task 6).
- Fetch scope (`fetchSnapshot(client, since: string | null, full: boolean): Promise<{ data: Partial<Snapshot>; failed: Collection[] }>`, where `data` holds only collections whose fetch completed (every page) and `failed` names the rest). Port blueprint to Snapshot key: `service`→`services`, `workload`→`workloads`, `datadogHost`→`hosts`, `sentryIssue`→`sentryIssues`, `datadogMonitor`→`monitors`, `jiraIssue`→`jira`, `githubPullRequest`→`prs`, `githubWorkflowRun`→`runs`, `deployment`→`deployments`, `GET /v1/integration`→`integrations`:

| Blueprint | Query | Window |
|---|---|---|
| `service`, `workload`, `datadogHost` | all | full every poll (tiny) |
| `sentryIssue` | `status = unresolved` | full on first load and every 5th poll; otherwise delta |
| `datadogMonitor` | all | full on first load and every 5th poll; otherwise delta |
| `jiraIssue` | relation `service` set, and either status not Done or `resolutionDate` in the window | 14 days plus open |
| `githubPullRequest` | `mergedAt` in the window | 14 days |
| `githubWorkflowRun` | `createdAt` in the window; the last 72 are sorted on the client | 14 days |
| `deployment` | `createdAt` in the window | 14 days |
| `GET /v1/integration` | all; a 403 is stored as `"forbidden"` | every poll |

  Window rules use `{ property, operator: "between", value: { from: startIso, to: nowIso } }`; the delta adds `{ property: "$updatedAt", operator: "between", value: { from: since, to: nowIso } }`. Full versus delta: a FULL fetch of a collection is authoritative, so that collection is replaced; a DELTA fetch (only entities updated since the last poll) is merged by `identifier` and never removes anything. A key absent from `data` (its fetch failed, a page is missing, or it is not scheduled this poll) means "unchanged", never "empty"; only a key that is present, including `[]` or `"forbidden"`, is authoritative. A failed or incomplete fetch therefore never clears an alarm. Confirm the `between` body against Port in the first live run (Task 12) and keep the test's asserted body in step with it.
- Produces: `mergeSnapshot(prev: Snapshot, delta: Partial<Snapshot>, replace: Collection[]): Snapshot`: collections named in `replace` are REPLACED by the fetched array (so an entity absent from a full response disappears), every other collection in `delta` is merged by `identifier` and then pruned to its window. the Snapshot keys `["services","workloads","hosts","integrations"]` are replaced every poll, `["sentryIssues","monitors"]` are added to `replace` on a full poll only, and every other key present in `delta` is merged. A key listed in `replace` but absent from `delta` is left unchanged. `diffBoards(prev: Board | null, next: Board): BoardEvent[]` with `BoardEvent = { at: string; kind: "alarm" | "merge" | "ci" | "jira" | "deploy" | "monitor"; station: StationId | null; host?: HostId; alarmId?: string; text: { en: string; ar: string }; replay?: boolean }`; `useBoard(): { board: Board | null; events: BoardEvent[]; status: "loading" | "ready" | "error" | "stale"; error: string | null; replaying: boolean; onReplayDone(): void }`. `station: null` means unlocated: the event is kept as received, listed in the Events tab with an "Unlocated" label, never animated, and never assigned a station or host.

- [ ] **Step 1: Write failing tests.** Test the scheduler as a pure function `nextPoll(state, now): { at: number; full: boolean }` and the hook with `vi.useFakeTimers({ shouldAdvanceTime: true })`: first load issues the window queries once with the exact asserted bodies; after 60 s only delta queries; the 5th poll is full; `document.hidden = true` or an `IntersectionObserver` callback with `isIntersecting: false` (stubbed in `vitest.setup.ts`, jsdom has none) stops polling until visible again; a rejected poll keeps the last board and sets `status: "stale"`; a new unresolved Sentry issue between polls yields one `alarm` event; a Datadog monitor with no workload and no host name entering Alert yields one `monitor` event with `station: null`, shown in the Events tab as "Unlocated" and passed to no gesture; on first load, entities created or updated in the last 24 h become `events` with `replay: true`, played once in time order, and `replaying` turns false after the last one has played (the diagram calls `onReplayDone()`).
- [ ] **Step 2:** Replace versus merge tests (Snapshot keys): (1) a full poll with `sentryIssues` present and one issue missing removes its alarm; (2) a full poll with `monitors: []` clears the monitor alarms, because a present empty key is authoritative; (3) a delta poll with `sentryIssues: []` removes nothing; (4) a delta poll that updates one Sentry issue merges it by `identifier` and leaves the other issues and their alarms unchanged (`services`, `workloads`, `hosts` and `integrations` are fetched in full on every poll, so they are never delta-merged); (5) a full poll in which the `sentryIssues` query rejects, or one page is missing, keeps every previous Sentry issue and its alarm unchanged, lists `sentryIssues` in `failed` and sets `status: "stale"`, while a collection fetched successfully in the same poll (for example `monitors: []`) still updates and clears its own alarms; (6) deleting a service between two polls, full or delta, removes it at the very next poll, because `services` is replaced every poll; deleting a Sentry issue between two polls removes its alarm at the next full poll, not at a delta in between.
- [ ] **Step 2a:** Replay is a reconstruction, not a history. Port keeps no change log, so replay only covers entities that still exist and changed in the last 24 h; resolved Sentry issues and past monitor states are not recoverable. The chip reads "Replaying recent changes (partial)" and the Events tab shows one line saying so. Tests: after a full poll in which a Sentry issue and a monitor are absent, their alarms are gone (replace semantics) while a delta poll keeps other alarms; deleting a Sentry issue or monitor between polls removes its alarm on the next full poll (a service, workload or host is removed on the very next poll); `integrations` becoming `"forbidden"` replaces the previous list.
- [ ] **Step 2b:** The Events tab lists `events` newest first: a merge (PR merged), a CI result (run concluded), a Jira status change (issue updated), a new Sentry issue, and a monitor state change.
- [ ] **Step 3–4:** Run (FAIL), implement on React Query (`refetchInterval: 60_000`, `enabled` gated on token and trusted base URL), run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 polling data layer with change events`.

### Task 8: Language, header, verdict and telemetry panels

**Files:**
- Create: `src/i18n/strings.ts`, `src/i18n/LangContext.tsx`, `src/components/{Header,Verdict,Telemetry,Trace}.tsx`
- Test: `src/components/__tests__/top.test.tsx`

**Interfaces:**
- Produces: `useLang(): { lang: "en" | "ar"; t: (key: StringKey) => string; setLang(l): void }` (sets `document.documentElement.lang` and `dir`); `fmtTime(d: Date, lang): string` (24-hour, Latin digits); components take `board`, `status`, `replaying`.

- [ ] **Step 1: Write failing tests:** switching to Arabic sets `dir="rtl"` and renders the Arabic verdict sentence; the header shows "Test lab, not real stores", the alarm count, "Lab updated N ago", and a `Replaying recent changes (partial)` chip only while replaying; a trace marks spikes and shows `yesterday` and the 13-day average; `status: "stale"` shows a stale chip; the theme button flips `data-theme` between dark and light; the Pause button sets a `paused` flag consumed by Task 9 and its label flips to Resume.
- [ ] **Step 2–4:** Run (FAIL), implement with copy taken from the mockup's `T.en` and `T.ar`, run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 header, verdict and telemetry`.

### Task 9: The control-room diagram and motion

**Files:**
- Create: `src/components/room/{ControlRoom,SourceBar,Station,Cable,Lamps,AlarmPin,Hosts,Legend}.tsx`, `src/components/room/icons.ts`, `src/components/room/gestures.ts`
- Test: `src/components/room/__tests__/room.test.tsx`, `src/components/room/__tests__/gestures.test.ts`

**Interfaces:**
- Consumes: `Board`, `BoardEvent`.
- Produces: `<ControlRoom board events paused replaying onReplayDone onSelect(sel: Selection) selection />` where `onReplayDone(): void` is the one from `useBoard`; with `Selection = { type: "station" | "alarm" | "host"; id: string } | null`; `ICONS: Record<AlarmKind | "unknown" | "ok", string>` (path data copied from the mockup); `playGesture(kind: AlarmKind, refs, opts: { paused: boolean; reducedMotion: boolean }): void`.

- [ ] **Step 1: Write failing tests:** the fixture board draws 5 stations, 4 cables, 3 hosts, 5 alarm pins (4 on `c4`, 1 on admin); `c4` has class `fault`, the others `live`; lamp text for Core Datadog reads `HLT 7/7`; every station, pin and host is a focusable `role="button"`; an unlocated alarm draws no pin and an event with `station: null` plays no gesture and requests no animation frame; with `paused` or `reducedMotion` no animation frame is requested; with fake timers, recording every opacity or class change during each gesture shows no two changes less than 500 ms apart; each riser's animation duration equals `180 / activity7d` seconds (POS `activity7d` 58 gives about 3.10 s). Replay and Pause, with fake timers: replayed events play once in time order and `onReplayDone` fires once after the last; Pause mid-flight removes the moving dot and runs no completion effect (ERPNext does not dim after a cancelled 502 gesture); Resume continues with the next event, not the cancelled one; under `reducedMotion` nothing animates and `onReplayDone` fires immediately. Keyboard and focus: Enter on a pin or station opens the detail; Escape or Back returns focus to the element that opened it, or to its re-rendered replacement (stable `data-focus` keys), but only if that element is visible (`getClientRects().length > 0`); otherwise to the visible pin with the same alarm id; otherwise to the active tab button (Alarms or Events); never to `body`. A mouse click on a non-focusable target clears the stored trigger (no stale restoration), and opening an alarm from inside a station detail keeps the first opener. Test with the Events tab active (the alarm-list button is hidden) and with the Alarms tab active. Selecting the demo example alarm, turning the example off while its detail is open, and switching language while it is open, never throw.
- [ ] **Step 2–4:** Run (FAIL), implement from the mockup's `drawGrid` geometry (viewBox `0 0 1240 820`, positions computed from `ARCH` tiers), run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 control-room diagram and alarm gestures`.

### Task 10: Alarm panel, detail, status table and lower panels

**Files:**
- Create: `src/components/{AlarmPanel,Detail,StatusTable,PerStation,JiraRiver,CiStrip,HealthChecks}.tsx`
- Test: `src/components/__tests__/panel.test.tsx`

**Interfaces:**
- Consumes: `Board`, `BoardEvent`, `Selection`.

- [ ] **Step 1: Write failing tests:** the Alarms tab lists 5 alarms then 2 "no health check" items, and, when an unlocated alarm exists, a separate "Not placed on the map" group above them; the Events tab shows an event with `station: null` with an "Unlocated" label and the original monitor title; selecting an alarm shows where, kind code, source, since, the path with the failing hop marked, the original message in `dir="ltr"`, and a link to Sentry; Enter on a station (via `@testing-library/user-event`) moves focus to the detail heading and Escape returns it; with fake timers, two alarm events 5 s apart produce one `role="status"` update and the second appears after 15 s; merge events never reach it; the per-station table shows "no data" for a missing value; the map's table view lists every station with state, alarms, health checks and both link states.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 alarm panel, detail and lower panels`.

### Task 11: Ops and Story modes, tour and demo flag

**Files:**
- Create: `src/components/{ModeSwitch,Tour}.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/__tests__/modes.test.tsx`

**Interfaces:**
- Produces: `mode: "ops" | "story"` in App state; `<Tour steps lang onEnd />` with Next, Previous and End, never advancing on a timer; `isDemo(): boolean` true only when the plugin URL has `demo=1`.

- [ ] **Step 1: Write failing tests:** Story hides station readings, the per-station table and the lower panels, keeps pins and the verdict, and shows the Tour button; the tour has 5 steps from the mockup's `TOUR` in both languages and stays on a step until Next; without `demo=1` there is no example button; with it the example latency alarm is labelled "example, not real".
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit `feat: RT-1381 Ops and Story modes with a guided tour`.

### Task 12: Build, README, review and release evidence

**Files:**
- Modify: `tools/port-plugins/rt-control-room/README.md`
- Create: `tools/port-plugins/rt-control-room/dist/index.html` (built)
- Update only if changed during the build: the design, the mockup and this plan (already on `main` via PR #570).

- [ ] **Step 1:** README: what the board shows, the data contract (copy the spec's table), the Port-side gaps, local dev (`npm run dev`, port 9000), build, and the upload command, run from the plugin folder with the local CLI (`@port-labs/port-plugins-cli`, bin `port-plugins`): `npx port-plugins upload --file dist/index.html --identifier rt-control-room --title "Retail Tower Control Room" --params "{}" --description "Live control room of Retail Tower services, cables and alarms" --upsert`.
- [ ] **Step 2:** Run `npm ci && npm test && npm run build && npm run check`. Expected: all tests pass, `dist ok <size>` under 1.5 MB, `src ok`.
- [ ] **Step 3:** Live check against Port with the owner's lab credentials (read-only): a viewer-level call to `GET /v1/integration` (record 200 or 403 on the RT issue), and one window query and one delta query with the `between` body. Fix the body in Task 7 if Port rejects it.
- [ ] **Step 4:** Run the `reviewing-pull-requests` skill in a fresh subagent on the branch; fix what it confirms.
- [ ] **Step 5:** Stage the plugin files by name (and the design, mockup or plan only if they changed during the build); commit `feat: RT-1381 build the rt-control-room plugin`. Push once and open the PR titled with `[GATED: deps/lockfile]`.
- [ ] **Step 6 (owner-authorized only):** Upload to Port with credentials from the environment, add the widget to the Retail Tower Cockpit, and post evidence on the RT issue: file size, upload result, screenshots in Port in both languages and both modes, and one real Sentry alarm traced to its pin.
