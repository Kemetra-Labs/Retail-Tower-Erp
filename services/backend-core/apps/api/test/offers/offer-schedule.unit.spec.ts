/**
 * RT-1337 — schedules and the derived lifecycle state (`offer-schedule.ts`):
 * the spec 041 §4.3 conventions for a `store_local` time (a spring-forward gap
 * resolves to the first valid instant after it, a repeated local time to the
 * earlier occurrence), `absolute` instants, the half-open window, and the
 * derived state of an offer. Pure: the clock is an argument.
 */
import {
  deriveState,
  normaliseLocal,
  parseLocalDateTime,
  resolveLocalInstant,
  resolveWindow,
  utcOffsetMs,
  windowClosed,
  windowOpen,
} from "../../src/offers/offer-schedule";

const iso = (d: Date): string => d.toISOString();
const HOUR = 3_600_000;

describe("parseLocalDateTime / normaliseLocal", () => {
  it("accepts a real local date-time with or without seconds and refuses anything else", () => {
    expect(parseLocalDateTime("2026-12-01T00:00")).toBe(Date.UTC(2026, 11, 1));
    expect(parseLocalDateTime("2026-12-01T23:59:59")).toBe(Date.UTC(2026, 11, 1, 23, 59, 59));
    for (const bad of ["2026-02-30T00:00", "2026-13-01T00:00", "2026-12-01T24:00", "2026-12-01T00:60", "2026-12-01", "2026-12-01T00:00Z", "2026-12-01 00:00"]) {
      expect(parseLocalDateTime(bad)).toBeNull();
    }
    expect(normaliseLocal("2026-12-01T00:00")).toBe("2026-12-01T00:00:00");
    expect(normaliseLocal("2026-12-01T00:00:30")).toBe("2026-12-01T00:00:30");
  });
});

describe("resolveLocalInstant", () => {
  it("resolves an ordinary local time in the zone's offset (Cairo, UTC+2 in winter and UTC+3 under DST)", () => {
    expect(iso(resolveLocalInstant("2026-12-01T00:00", "Africa/Cairo"))).toBe("2026-11-30T22:00:00.000Z");
    expect(iso(resolveLocalInstant("2026-07-01T00:00", "Africa/Cairo"))).toBe("2026-06-30T21:00:00.000Z");
    expect(iso(resolveLocalInstant("2026-07-01T00:00", "UTC"))).toBe("2026-07-01T00:00:00.000Z");
    expect(utcOffsetMs("Africa/Cairo", Date.UTC(2026, 11, 1))).toBe(2 * HOUR);
  });

  it("a local time in a spring-forward gap resolves to the first valid instant after it (America/New_York, 2026-03-08 02:30)", () => {
    // 02:00-03:00 does not exist; the clock jumps from 02:00 EST (07:00Z) to 03:00 EDT (07:00Z).
    expect(iso(resolveLocalInstant("2026-03-08T02:30", "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(resolveLocalInstant("2026-03-08T02:00", "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(resolveLocalInstant("2026-03-08T03:00", "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(resolveLocalInstant("2026-03-08T01:59", "America/New_York"))).toBe("2026-03-08T06:59:00.000Z");
  });

  it("a local time that occurs twice resolves to the earlier occurrence (America/New_York, 2026-11-01 01:30)", () => {
    // 01:00-02:00 happens twice: first as EDT (05:30Z), then as EST (06:30Z).
    expect(iso(resolveLocalInstant("2026-11-01T01:30", "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(resolveLocalInstant("2026-11-01T02:30", "America/New_York"))).toBe("2026-11-01T07:30:00.000Z");
  });

  it("refuses a value that is not a local date-time", () => {
    expect(() => resolveLocalInstant("2026-12-01T00:00Z", "UTC")).toThrow(RangeError);
  });
});

describe("windows", () => {
  const local = { timeBasis: "store_local" as const, startsAt: "2026-12-01T00:00:00", endsAt: "2026-12-31T00:00:00" };
  const absolute = { timeBasis: "absolute" as const, startsAt: "2026-12-01T00:00:00.000Z", endsAt: null };

  it("resolves a store_local schedule per store zone and an absolute one the same everywhere", () => {
    expect(iso(resolveWindow(local, "Africa/Cairo").startsAt)).toBe("2026-11-30T22:00:00.000Z");
    expect(iso(resolveWindow(local, "UTC").startsAt)).toBe("2026-12-01T00:00:00.000Z");
    expect(iso(resolveWindow(absolute, "Africa/Cairo").startsAt)).toBe("2026-12-01T00:00:00.000Z");
    expect(resolveWindow(absolute, "UTC").endsAt).toBeNull();
  });

  it("is half-open: [startsAt, endsAt)", () => {
    const w = resolveWindow(local, "UTC");
    const at = (iso: string): Date => new Date(iso);
    expect(windowOpen(w, at("2026-11-30T23:59:59.999Z"))).toBe(false);
    expect(windowOpen(w, at("2026-12-01T00:00:00.000Z"))).toBe(true);
    expect(windowOpen(w, at("2026-12-30T23:59:59.999Z"))).toBe(true);
    expect(windowOpen(w, at("2026-12-31T00:00:00.000Z"))).toBe(false);
    expect(windowClosed(w, at("2026-12-31T00:00:00.000Z"))).toBe(true);
    expect(windowClosed(resolveWindow(absolute, "UTC"), at("2099-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("deriveState", () => {
  const now = new Date("2026-12-15T12:00:00.000Z");
  const open = resolveWindow({ timeBasis: "absolute", startsAt: "2026-12-01T00:00:00.000Z", endsAt: null }, "UTC");
  const future = resolveWindow({ timeBasis: "absolute", startsAt: "2027-01-01T00:00:00.000Z", endsAt: null }, "UTC");
  const past = resolveWindow({ timeBasis: "absolute", startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-02-01T00:00:00.000Z" }, "UTC");
  const facts = (over: Partial<Parameters<typeof deriveState>[0]> = {}) => ({
    hasVersion: true, archived: false, endedExplicitly: false, wholeOfferPaused: false, windows: [open], now, ...over,
  });

  it.each([
    ["archived wins over everything", facts({ archived: true, endedExplicitly: true, wholeOfferPaused: true }), "archived"],
    ["no published version is a draft", facts({ hasVersion: false, windows: [] }), "draft"],
    ["an explicit end is ended even inside the window", facts({ endedExplicitly: true }), "ended"],
    ["a whole-offer pause is paused, even after the window closed", facts({ wholeOfferPaused: true, windows: [past] }), "paused"],
    ["closed in every store is ended", facts({ windows: [past, past] }), "ended"],
    ["open in at least one store is active", facts({ windows: [past, open, future] }), "active"],
    ["not yet open anywhere is scheduled", facts({ windows: [future] }), "scheduled"],
    ["an unpaused offer inside its window is active", facts(), "active"],
  ])("%s", (_label, f, expected) => {
    expect(deriveState(f)).toBe(expected);
  });
});
