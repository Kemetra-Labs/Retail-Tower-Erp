// Raw Port entity shapes (spec section 6) and the view types the board renders.
// Read-only widget: nothing here is ever written back to Port.

/** A relation value as Port returns it: one identifier, several, or none. */
export type Relation = string | string[] | null | undefined;

export type PortEntity<P, R> = {
  identifier: string;
  title: string;
  properties: P;
  relations: R;
  createdAt: string;
  updatedAt: string;
};

export type ServiceEntity = PortEntity<
  {
    runtime?: string | null;
    github_workflow_runs_7d?: number | null;
    github_failed_workflow_runs_7d?: number | null;
  },
  Record<string, Relation>
>;

export type WorkloadEntity = PortEntity<
  Record<string, unknown>,
  { service?: Relation; sentry_project?: Relation; datadog_service?: Relation }
>;

export type SentryIssue = PortEntity<
  { status?: string | null; isUnhandled?: boolean | null; link?: string | null },
  { workload?: Relation }
>;

export type DatadogMonitor = PortEntity<
  { overallState?: string | null; link?: string | null; tags?: string[] | null },
  // `service` holds a workload identifier, not a service identifier.
  { service?: Relation }
>;

export type DatadogHost = PortEntity<{ up?: boolean | null; host_name?: string | null }, Record<string, Relation>>;

export type JiraIssue = PortEntity<
  { status?: string | null; resolutionDate?: string | null },
  { service?: Relation }
>;

export type PullRequest = PortEntity<
  { status?: string | null; mergedAt?: string | null },
  { service?: Relation }
>;

export type WorkflowRun = PortEntity<
  { conclusion?: string | null; createdAt?: string | null },
  { service?: Relation }
>;

export type Deployment = PortEntity<Record<string, unknown>, { service?: Relation }>;

export type Integration = {
  installationId: string;
  integrationType: string;
  resyncState?: { lastResyncEnd?: string | null; status?: string | null } | null;
};

export type Snapshot = {
  services: ServiceEntity[];
  workloads: WorkloadEntity[];
  sentryIssues: SentryIssue[];
  monitors: DatadogMonitor[];
  hosts: DatadogHost[];
  jira: JiraIssue[];
  prs: PullRequest[];
  runs: WorkflowRun[];
  deployments: Deployment[];
  integrations: Integration[] | "forbidden";
  fetchedAt: string;
};

/** A key of Snapshot that holds a collection. Never a Port blueprint id. */
export type Collection = Exclude<keyof Snapshot, "fetchedAt">;

export type StationId = "pos" | "admin" | "core" | "conn" | "erp";
export type CableId = "c1" | "c2" | "c3" | "c4";
/** The Datadog host_name exactly as Port stores it; never normalised. */
export type HostId = "lab-01" | "lab-02" | "lab-03";
export type AlarmKind =
  | "refused"
  | "down"
  | "timeout"
  | "reset"
  | "bug"
  | "latency"
  | "nodata"
  | "monitor";
export type AlarmAt = StationId | CableId | HostId | "unlocated";

export type Alarm = {
  id: string;
  kind: AlarmKind;
  source: "Sentry" | "Datadog";
  station: StationId | null;
  at: AlarmAt;
  title: string;
  message: string;
  since: string | null;
  link: string | null;
  example?: boolean;
};

export type I18n = { en: string; ar: string };

// ---- View types (Task 4 and Task 6 fill these in) --------------------------

export type SourceId = "sentry" | "datadog" | "github" | "jira";
export type LinkState = "sending" | "live" | "linked" | "none" | "na" | "alert";
export type Lamp = {
  state: LinkState;
  checks?: { ok: number; total: number };
  /** The collection behind this lamp was never read, so "none" means "not read", not "nothing there". */
  unread?: boolean;
};

/** Alarm count of a station: a number, or "not-read" when the Sentry read failed (never 0). */
export type AlarmReading = number | "not-read";

export type StationView = {
  id: StationId;
  name: string;
  role: I18n;
  lamps: Record<SourceId, Lamp>;
  readings: {
    alarms: AlarmReading;
    checks: { ok: number; total: number } | "na" | null;
    ci7d: number | null;
    tasks: number | null;
    prs: number | null;
    merged7d: number | null;
    deploys: number | null;
    ciFails7d: number | null;
  };
  merged13d: number[];
  activity7d: number;
};

export type CableView = {
  id: CableId;
  from: StationId;
  to: StationId;
  carries: I18n;
  state: "live" | "fault";
  faults: number;
  /**
   * Some source could place a fault on this cable: the station that reports
   * its faults (POS for c1, Admin Console for c2, the Connector for c3 and c4)
   * has a Sentry project. An unwatched cable reads "Not watched", never "no faults".
   */
  watched: boolean;
};

export type SourceView = {
  id: SourceId;
  state: "fresh" | "stale" | "unknown";
  lastChange: string | null;
  lastSync: string | null;
};

export type TraceView = {
  key: "merged" | "runs" | "fails" | "done";
  series: number[];
  yesterday: number;
  average: number;
  band: [number, number];
  cap: number;
  spikes: number[];
  /** The collection behind this trace was never read: it reads "no data", not a flat zero line. */
  unread?: boolean;
};

export type HostView = {
  id: HostId;
  station: StationId;
  up: boolean | null;
  checks: { ok: number; total: number };
  /** The monitors were never read: the checks read "not read", not "none". */
  unread?: boolean;
};

export type PerStationRow = {
  station: StationId;
  tasks: number | null;
  prs: number | null;
  runs: number | null;
  failed: number | null;
};

/**
 * Datadog checks grouped by what they watch. The station groups come from the
 * station's Datadog lamp (so an example alarm lowers `ok` as everywhere else);
 * `servers` are the multi-host checks, `databases` the checks that name one
 * server, `other` any check that cannot be placed. A group with `total` 0 and
 * `na` false has no check at all: unknown, never healthy.
 */
export type HealthGroup = {
  key: "core" | "servers" | "databases" | "admin" | "conn" | "pos" | "other";
  ok: number;
  total: number;
  /** A check of the group is in alarm. */
  alert: boolean;
  /** The group needs no check by design (POS). */
  na: boolean;
  /** The monitors were never read: the group reads "not read", not "none". */
  unread?: boolean;
};

export type Light = {
  tone: "fault" | "unknown" | "neutral";
  text: I18n;
};

export type Verdict = {
  lights: { cashier: Light; backend: Light; accounts: Light };
  sentence: I18n;
};

export type Board = {
  stations: StationView[];
  cables: CableView[];
  alarms: Alarm[];
  unknowns: { station: StationId; reason: "no-health-check" }[];
  sources: Record<SourceId, SourceView>;
  telemetry: TraceView[];
  verdict: Verdict;
  hosts: HostView[];
  perStation: PerStationRow[];
  healthChecks: HealthGroup[];
  /** Issues per status; `null` when Jira was never read ("no data", never 0). */
  jira: Record<"todo" | "inProgress" | "review" | "done", number | null>;
  /** Empty and `null` when the workflow runs were never read ("no data"). */
  ci: { last72: ("s" | "f" | "c" | "k")[]; passRate: number | null };
  /** `sentry` is false when the error read never succeeded or the latest read failed: counts are then "not read", not 0. */
  alarmRead: { sentry: boolean };
};
