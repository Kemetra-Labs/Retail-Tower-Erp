import { isHostId } from "../model/architecture";
import type { Alarm, Board, Collection, HostId, I18n, StationId } from "../model/types";

export type EventKind = "alarm" | "merge" | "ci" | "jira" | "deploy" | "monitor";

/**
 * One change on the board. `station: null` means unlocated: the event is kept
 * as received, listed with an "Unlocated" label, never animated and never
 * given a station or host. `id` is stable across polls (a React key and the
 * dedupe key); `at` is an ISO instant.
 */
export type BoardEvent = {
  id: string;
  at: string;
  kind: EventKind;
  station: StationId | null;
  host?: HostId;
  alarmId?: string;
  text: I18n;
  replay?: boolean;
};

export type DiffOptions = {
  /**
   * Collections read successfully for the first time in this poll. Their
   * content is a baseline, not a change, so it raises no event.
   */
  baseline?: ReadonlySet<Collection>;
  /** ISO instant of this poll; the time of an event with no better timestamp. */
  at?: string;
};

export const eventId = (kind: EventKind, key: string, at: string): string => `${kind}:${key}:${at}`;

const validStamp = (value: string | null): string | null =>
  value !== null && !Number.isNaN(Date.parse(value)) ? value : null;

export function alarmEvent(alarm: Alarm, at: string): BoardEvent {
  if (alarm.source === "Sentry") {
    const when = validStamp(alarm.since) ?? at;
    return {
      id: eventId("alarm", alarm.id, when),
      at: when,
      kind: "alarm",
      station: alarm.station,
      alarmId: alarm.id,
      text: { en: `New error: ${alarm.title}`, ar: `خطأ جديد: ${alarm.title}` },
    };
  }
  return {
    id: eventId("monitor", alarm.id, at),
    at,
    kind: "monitor",
    station: alarm.station,
    ...(isHostId(alarm.at) ? { host: alarm.at } : {}),
    alarmId: alarm.id,
    text: { en: `Monitor alert: ${alarm.title}`, ar: `تنبيه من المراقبة: ${alarm.title}` },
  };
}

/**
 * Alarm changes between two boards: an alarm present now and not before. A
 * new Sentry issue is one `alarm` event; a Datadog monitor entering an alarm
 * state is one `monitor` event (never a second `alarm`), with `station: null`
 * when it cannot be placed. With no previous board there is nothing to compare.
 */
export function diffBoards(prev: Board | null, next: Board, opts: DiffOptions = {}): BoardEvent[] {
  if (prev === null) return [];
  const at = opts.at ?? new Date().toISOString();
  const known = new Set(prev.alarms.map((a) => a.id));
  return next.alarms
    .filter((a) => !a.example && !known.has(a.id))
    .filter((a) => !opts.baseline?.has(a.source === "Sentry" ? "sentryIssues" : "monitors"))
    .map((a) => alarmEvent(a, at));
}
