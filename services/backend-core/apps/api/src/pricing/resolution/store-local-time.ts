/**
 * Store-local time for the pricing resolver (spec 041 §4.3, Q-2; RT-1484 PR-1).
 *
 * A `store_local` price event stores a wall-clock date-time; its instant per
 * Store is that value read in the Store's IANA zone (`stores.timezone`). The
 * DST rule is fixed so the resolver stays deterministic:
 *
 *   - a local time that does not exist (spring-forward gap) resolves to the
 *     first valid instant after it, which is the transition itself;
 *   - a local time that occurs twice (fall-back) resolves to the earlier
 *     occurrence.
 *
 * The zone must pass the Store contract's shape rule (`stores/timezone.ts`);
 * the time-zone database is the runtime's ICU (`Intl`). PostgreSQL stays the
 * authority for business dates (spec 038); this only orders price intervals.
 *
 * Wall-clock values use Drizzle's `timestamp without time zone` convention: a
 * `Date` whose UTC fields are the local date-time.
 */
import { isIanaTimezoneShape } from "../../stores";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Wider than any real offset change, so both sides of one transition are sampled. */
const PROBE = 36 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  if (!isIanaTimezoneShape(zone)) {
    throw new RangeError(`Not a canonical IANA time zone: ${zone}`);
  }
  // Intl throws RangeError for a well-shaped name the runtime does not know.
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    era: "short",
  });
  formatters.set(zone, created);
  return created;
}

/** `zone`'s UTC offset in ms at `instantMs` (local = instant + offset). */
function offsetAt(instantMs: number, zone: string): number {
  const fields: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instantMs))) fields[part.type] = part.value;
  const year = Number(fields["year"]) * (fields["era"] === "BC" ? -1 : 1);
  const asUtc = Date.UTC(
    year,
    Number(fields["month"]) - 1,
    Number(fields["day"]),
    Number(fields["hour"]),
    Number(fields["minute"]),
    Number(fields["second"]),
  );
  // Intl has whole-second precision: compare against the instant's whole second.
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function assertValid(date: Date): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError("Invalid date");
  return ms;
}

/**
 * The instant at which the wall-clock time `local` (UTC fields = local
 * date-time) occurs in `zone`, under the Q-2 DST rule.
 */
export function localWallClockToInstant(local: Date, zone: string): Date {
  const localMs = assertValid(local);
  const offsets = new Set([offsetAt(localMs - PROBE, zone), offsetAt(localMs, zone), offsetAt(localMs + PROBE, zone)]);
  let earliest: number | null = null;
  for (const offset of offsets) {
    const candidate = localMs - offset;
    if (offsetAt(candidate, zone) === offset && (earliest === null || candidate < earliest)) earliest = candidate;
  }
  if (earliest !== null) return new Date(earliest);
  return new Date(firstInstantAtOrAfter(localMs, [...offsets], zone));
}

/**
 * The gap case: the first instant whose local time is at or after `localMs`.
 * Within one transition the local time only jumps forward, so a binary search
 * between the two candidate instants finds the transition to the millisecond.
 */
function firstInstantAtOrAfter(localMs: number, offsets: ReadonlyArray<number>, zone: string): number {
  let lo = localMs - Math.max(...offsets);
  let hi = localMs - Math.min(...offsets);
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (mid + offsetAt(mid, zone) >= localMs) hi = mid;
    else lo = mid;
  }
  return hi;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * `instant` as an RFC 3339 date-time with `zone`'s offset at that instant
 * (`2026-11-01T00:00:00+02:00`; `Z` at offset zero). A historical offset that
 * is not a whole minute (local mean time) cannot be written in RFC 3339, so
 * that instant is written in UTC.
 */
export function formatInstantInZone(instant: Date, zone: string): string {
  const ms = assertValid(instant);
  const offset = offsetAt(ms, zone);
  const shown = offset % MINUTE === 0 ? offset : 0;
  const local = new Date(ms + shown);
  const millis = local.getUTCMilliseconds();
  const body =
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    (millis === 0 ? "" : `.${pad(millis, 3)}`);
  if (shown === 0) return `${body}Z`;
  const abs = Math.abs(shown) / MINUTE;
  return `${body}${shown < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
