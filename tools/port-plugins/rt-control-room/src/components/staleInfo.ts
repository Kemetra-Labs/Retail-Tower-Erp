import type { StringKey } from "../i18n/strings";
import type { Collection } from "../model/types";

/** Collections whose old data could hide an alarm: the error tracker and the Datadog monitors. */
const ALARM_SOURCES: Collection[] = ["sentryIssues", "monitors"];

/**
 * Whether a stale board may be missing alarms. Unknown failures (`failed` not given) say yes, the
 * safe side; a failed Jira, GitHub or deployment read does not hide an alarm.
 */
export function alarmsMayBeMissing(failed?: readonly Collection[]): boolean {
  // A stale board with no named failure (the poll itself threw) could be missing anything.
  return failed === undefined || failed.length === 0 || failed.some((c) => ALARM_SOURCES.includes(c));
}

const SOURCE_OF: Record<Collection, StringKey> = {
  sentryIssues: "srcSentry",
  monitors: "srcDatadog",
  hosts: "srcDatadog",
  jira: "srcJira",
  prs: "srcGithub",
  runs: "srcGithub",
  deployments: "srcGithub",
  services: "srcPort",
  workloads: "srcPort",
  integrations: "srcPort",
};

/** The source names (error tracker, code history, ...) behind the failed collections, once each, in order. */
export function staleSources(failed: readonly Collection[] | undefined): StringKey[] {
  return Array.from(new Set((failed ?? []).map((c) => SOURCE_OF[c])));
}
