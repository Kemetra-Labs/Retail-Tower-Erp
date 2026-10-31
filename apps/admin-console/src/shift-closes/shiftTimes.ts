/**
 * RT-1015 pure model of the shift time bar. No React, no fetch. It places the
 * served `openedAt`, `closedAt` and `receivedAt` along one axis and derives the
 * whole-minute duration; it never touches a cash figure.
 *
 * The axis runs from the open to the later of the close and the server's
 * recording, with a little padding so the first and last marks are not cut.
 * Anything it cannot place honestly is omitted: no `openedAt` (or an
 * unreadable open/close) means no model at all; a close before the open (the
 * POS clock) or a zero-length shift means no bar and no duration, and the
 * times stay as text.
 */

export interface ShiftTimes {
  openedAt?: string | null;
  closedAt?: string | null;
  receivedAt?: string | null;
}

export interface TimeBarMarks {
  /** Percent along the axis, from the inline start. */
  startPct: number;
  endPct: number;
  receivedPct: number;
}

export interface ShiftTimeFacts {
  bar: TimeBarMarks | null;
  /** Whole minutes between the open and the close; null when not meaningful. */
  durationMinutes: number | null;
}

const PAD = 0.06;

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function markFor(opened: number, closed: number, received: number | null): TimeBarMarks | null {
  const recorded = received ?? closed;
  const last = Math.max(closed, recorded);
  const total = last - opened;
  if (total <= 0) return null;
  const pad = total * PAD;
  const from = opened - pad;
  const width = total + pad * 2;
  const pct = (ms: number) => round1(((ms - from) / width) * 100);
  return { startPct: pct(opened), endPct: pct(closed), receivedPct: pct(recorded) };
}

/** The model, or null when the shift has no readable open (AC 3) or close. */
export function shiftTimeFacts(times: ShiftTimes): ShiftTimeFacts | null {
  const opened = instant(times.openedAt);
  const closed = instant(times.closedAt);
  if (opened === null || closed === null) return null;
  if (closed < opened) return { bar: null, durationMinutes: null };
  const minutes = Math.floor((closed - opened) / 60_000);
  return {
    bar: markFor(opened, closed, instant(times.receivedAt)),
    durationMinutes: minutes > 0 ? minutes : null,
  };
}

/** Whole hours and the minutes left over, for a duration phrase. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
