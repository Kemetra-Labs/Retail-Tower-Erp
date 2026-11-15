/**
 * Port blueprint identifiers and the relation the widget reads. These are the
 * defaults of the Retail Tower Port catalog (checked 2026-11-13); the widget
 * takes no upload params, so a renamed blueprint is a one-line change here.
 */
export const BLUEPRINTS = {
  service: "service",
  workload: "workload",
  host: "datadogHost",
  sentryIssue: "sentryIssue",
  monitor: "datadogMonitor",
  jira: "jiraIssue",
  pullRequest: "githubPullRequest",
  workflowRun: "githubWorkflowRun",
  deployment: "deployment",
} as const;

/** The Jira issue relation that points at a `service` entity. */
export const JIRA_SERVICE_RELATION = "service";

/** The collections that give the board its meaning: alarms, health and the map itself. */
export const CORE_COLLECTIONS = ["services", "workloads", "sentryIssues", "monitors", "hosts"] as const;
/** Collections whose blueprint may simply not be shared with the widget (a 403 or 404 reads "not available"). */
export const OPTIONAL_COLLECTIONS = ["jira", "prs", "runs", "deployments"] as const;

/** Poll cadence. */
export const POLL_MS = 60_000;
/** Back-off after a failed poll: the delay doubles from POLL_MS and stops here. */
export const MAX_BACKOFF_MS = 5 * 60_000;
/** Poll number n (1 = first load) is a full poll when n === 1 or n % FULL_EVERY === 0. */
export const FULL_EVERY = 5;
/** Window of the windowed blueprints: 13 completed Cairo days plus today fit inside 14 x 24 h. */
export const WINDOW_DAYS = 14;
export const DAY_MS = 86_400_000;
/** Replay covers entities created or updated in the last 24 hours. */
export const REPLAY_MS = DAY_MS;
/** The Events list keeps this many events (480 CI runs in a day were seen). */
export const EVENT_LIMIT = 300;
