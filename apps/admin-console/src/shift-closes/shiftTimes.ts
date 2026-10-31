/**
 * RT-1015 pure model of the shift time bar. No React, no fetch. It places the
 * served `openedAt`, `closedAt` and `receivedAt` along one axis and derives the
 * whole-minute duration; it never touches a cash figure.
 *
 * The axis runs from the open to the close, with a little padding so the first
 * and last marks are not cut. The server's recording is a mark only when it
 * lands inside that window (clocks differ: a POS clock ahead of the server, or
 * a close synced months late, would put it far outside), otherwise it is left
 * to the text. Anything it cannot place honestly is omitted: no `openedAt` (or an
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
  /** The server's recording, or null when it falls outside the axis (the text still states it). */
  receivedPct: number | null;
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
  const total = closed - opened;
  if (total <= 0) return null;
  const pad = total * PAD;
  const from = opened - pad;
  const to = closed + pad;
  const pct = (ms: number) => round1(((ms - from) / (to - from)) * 100);
  const inside = received !== null && received >= from && received <= to;
  return {
    startPct: pct(opened),
    endPct: pct(closed),
    receivedPct: inside ? pct(received) : null,
  };
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
