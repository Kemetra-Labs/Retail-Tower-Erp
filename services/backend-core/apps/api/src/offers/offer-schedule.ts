/**
 * Offer schedules and the derived lifecycle state (spec 048 §4; contract
 * `offers.openapi.yaml` `OfferSchedule`, `OfferState`; Jira RT-1337).
 *
 * `store_local` schedules are local date-times without an offset, resolved in
 * each store's IANA timezone by the spec 041 §4.3 conventions: a local time in
 * a spring-forward gap resolves to the first valid instant after it, and one
 * that occurs twice to the earlier occurrence. `absolute` schedules are RFC
 * 3339 instants, the same for every store. The window is `[startsAt, endsAt)`.
 *
 * PURE: the clock is an argument. Resolution uses `Intl` (the engine's tz
 * database), never the workstation zone.
 */

export type OfferTimeBasis = "store_local" | "absolute";

export interface OfferScheduleValue {
  readonly timeBasis: OfferTimeBasis;
  readonly startsAt: string;
  readonly endsAt: string | null;
}

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The zone's UTC offset in ms at an instant (local wall time minus UTC), whole seconds. */
export function utcOffsetMs(timeZone: string, instantMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** A local date-time as milliseconds read as if it were UTC, or null when it is not a real calendar time. */
export function parseLocalDateTime(local: string): number | null {
  const m = LOCAL_PATTERN.exec(local);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "00"].map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return ms;
}

/** A local date-time normalised to whole seconds ("2026-12-01T00:00" -> "2026-12-01T00:00:00"). */
export function normaliseLocal(local: string): string {
  return local.length === 16 ? `${local}:00` : local;
}

/** Resolve a local date-time in `timeZone` to an instant (spec 041 §4.3: gap -> first valid instant after, overlap -> earlier). */
export function resolveLocalInstant(local: string, timeZone: string): Date {
  const localMs = parseLocalDateTime(local);
  if (localMs === null) throw new RangeError(`not a local date-time: ${local}`);
  const offsets = [...new Set([utcOffsetMs(timeZone, localMs - DAY_MS), utcOffsetMs(timeZone, localMs + DAY_MS)])];
  const valid = offsets
    .map((o) => localMs - o)
    .filter((instant) => utcOffsetMs(timeZone, instant) === localMs - instant)
    .sort((a, b) => a - b);
  if (valid.length > 0) return new Date(valid[0]!);
  // A gap: the offset before it (o1) and after it (o2); the transition instant T is in (localMs - o2, localMs - o1].
  const o1 = utcOffsetMs(timeZone, localMs - DAY_MS);
  const o2 = utcOffsetMs(timeZone, localMs + DAY_MS);
  let lo = localMs - o2; // exclusive: still offset o1 right at or before it
  let hi = localMs - o1; // inclusive: offset o2
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (utcOffsetMs(timeZone, mid) === o2) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

export interface ResolvedWindow {
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

/** The window of a schedule in one store (`timeZone` is ignored for an `absolute` schedule). */
export function resolveWindow(schedule: OfferScheduleValue, timeZone: string): ResolvedWindow {
  if (schedule.timeBasis === "absolute") {
    return { startsAt: new Date(schedule.startsAt), endsAt: schedule.endsAt === null ? null : new Date(schedule.endsAt) };
  }
  return {
    startsAt: resolveLocalInstant(schedule.startsAt, timeZone),
    endsAt: schedule.endsAt === null ? null : resolveLocalInstant(schedule.endsAt, timeZone),
  };
}

/** True when the window has closed at `now` (an open-ended window never closes). */
export function windowClosed(window: ResolvedWindow, now: Date): boolean {
  return window.endsAt !== null && window.endsAt.getTime() <= now.getTime();
}

export function windowOpen(window: ResolvedWindow, now: Date): boolean {
  return window.startsAt.getTime() <= now.getTime() && !windowClosed(window, now);
}

export type OfferLifecycleState = "draft" | "scheduled" | "active" | "paused" | "ended" | "archived";

export interface StateFacts {
  readonly hasVersion: boolean;
  readonly archived: boolean;
  readonly endedExplicitly: boolean;
  readonly wholeOfferPaused: boolean;
  /** The current version's window in each store of its scope (at least one entry; UTC when the scope is empty). */
  readonly windows: ReadonlyArray<ResolvedWindow>;
  readonly now: Date;
}

/**
 * The derived state (contract `OfferState`). A published, unpaused offer is
 * `scheduled` before its window opens in every store of its scope, `active`
 * while the window is open in at least one store, and `ended` once the window
 * has closed in every store or it was ended explicitly; a whole-offer pause is
 * `paused`; `archived` is terminal.
 */
export function deriveState(facts: StateFacts): OfferLifecycleState {
  if (facts.archived) return "archived";
  if (!facts.hasVersion) return "draft";
  if (facts.endedExplicitly) return "ended";
  if (facts.wholeOfferPaused) return "paused";
  if (facts.windows.length > 0 && facts.windows.every((w) => windowClosed(w, facts.now))) return "ended";
  if (facts.windows.some((w) => windowOpen(w, facts.now))) return "active";
  return "scheduled";
}
