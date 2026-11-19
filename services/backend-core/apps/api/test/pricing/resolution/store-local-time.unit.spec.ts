/**
 * RT-1484 PR-1 (RT-282 PR-08a) — Store-local time for the pricing resolver
 * (spec 041 §4.3, Q-2 DST rule): a non-existent local time resolves to the
 * first valid instant after it, a repeated one to the earlier occurrence.
 * No database.
 */
import { formatInstantInZone, localWallClockToInstant } from "../../../src/pricing/resolution/store-local-time";

/** A wall-clock value in Drizzle's convention: its UTC fields are the local date-time. */
const wall = (iso: string): Date => new Date(`${iso}Z`);
const instant = (date: Date): string => date.toISOString();

describe("localWallClockToInstant", () => {
  it("is the identity in UTC", () => {
    expect(instant(localWallClockToInstant(wall("2026-11-01T00:00:00"), "UTC"))).toBe("2026-11-01T00:00:00.000Z");
  });

  it("applies a fixed offset outside any transition", () => {
    // Africa/Cairo is UTC+2 in winter.
    expect(instant(localWallClockToInstant(wall("2026-12-01T09:30:00"), "Africa/Cairo"))).toBe(
      "2026-12-01T07:30:00.000Z",
    );
    // Asia/Kolkata is UTC+5:30 all year.
    expect(instant(localWallClockToInstant(wall("2026-06-15T12:00:00"), "Asia/Kolkata"))).toBe(
      "2026-06-15T06:30:00.000Z",
    );
  });

  describe("spring-forward gap (a local time that does not exist)", () => {
    // America/New_York 2026-03-08: 02:00 EST jumps to 03:00 EDT at 07:00Z.
    it.each(["2026-03-08T02:00:00", "2026-03-08T02:30:00", "2026-03-08T02:59:59.999"])(
      "%s resolves to the first valid instant after it (the transition)",
      (local) => {
        expect(instant(localWallClockToInstant(wall(local), "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
      },
    );

    it("the last instant before the gap and the first after it are unchanged", () => {
      expect(instant(localWallClockToInstant(wall("2026-03-08T01:59:59"), "America/New_York"))).toBe(
        "2026-03-08T06:59:59.000Z",
      );
      expect(instant(localWallClockToInstant(wall("2026-03-08T03:00:00"), "America/New_York"))).toBe(
        "2026-03-08T07:00:00.000Z",
      );
    });

    it("handles a midnight gap (Africa/Cairo 2026-04-24, 00:00 -> 01:00)", () => {
      // Egypt restarted DST in 2023: last Friday of April, 00:00 local becomes 01:00.
      expect(instant(localWallClockToInstant(wall("2026-04-24T00:00:00"), "Africa/Cairo"))).toBe(
        "2026-04-23T22:00:00.000Z",
      );
      expect(instant(localWallClockToInstant(wall("2026-04-24T00:30:00"), "Africa/Cairo"))).toBe(
        "2026-04-23T22:00:00.000Z",
      );
    });
  });

  describe("fall-back overlap (a local time that occurs twice)", () => {
    // America/New_York 2026-11-01: 02:00 EDT falls back to 01:00 EST at 06:00Z.
    it("resolves to the earlier occurrence", () => {
      expect(instant(localWallClockToInstant(wall("2026-11-01T01:00:00"), "America/New_York"))).toBe(
        "2026-11-01T05:00:00.000Z",
      );
      expect(instant(localWallClockToInstant(wall("2026-11-01T01:30:00"), "America/New_York"))).toBe(
        "2026-11-01T05:30:00.000Z",
      );
    });

    it("leaves the first local time after the repeat unambiguous", () => {
      expect(instant(localWallClockToInstant(wall("2026-11-01T02:00:00"), "America/New_York"))).toBe(
        "2026-11-01T07:00:00.000Z",
      );
    });

    it("handles Europe/London (01:00-02:00 repeats on 2026-10-25)", () => {
      expect(instant(localWallClockToInstant(wall("2026-10-25T01:15:00"), "Europe/London"))).toBe(
        "2026-10-25T00:15:00.000Z",
      );
    });
  });

  it("rejects a zone that is not a canonical IANA name", () => {
    expect(() => localWallClockToInstant(wall("2026-11-01T00:00:00"), "EET")).toThrow(RangeError);
    expect(() => localWallClockToInstant(wall("2026-11-01T00:00:00"), "Africa/Nowhere")).toThrow(RangeError);
  });

  it("rejects an invalid date", () => {
    expect(() => localWallClockToInstant(new Date(Number.NaN), "UTC")).toThrow(RangeError);
  });
});

describe("formatInstantInZone", () => {
  it("prints the instant with the Store's offset", () => {
    expect(formatInstantInZone(new Date("2026-10-31T22:00:00Z"), "Africa/Cairo")).toBe("2026-11-01T00:00:00+02:00");
    expect(formatInstantInZone(new Date("2026-06-15T06:30:00Z"), "Asia/Kolkata")).toBe("2026-06-15T12:00:00+05:30");
    expect(formatInstantInZone(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01T01:30:00-04:00");
    expect(formatInstantInZone(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01T01:30:00-05:00");
  });

  it("uses Z for UTC and keeps milliseconds when present", () => {
    expect(formatInstantInZone(new Date("2026-11-01T00:00:00Z"), "UTC")).toBe("2026-11-01T00:00:00Z");
    expect(formatInstantInZone(new Date("2026-11-01T00:00:00.250Z"), "UTC")).toBe("2026-11-01T00:00:00.250Z");
  });

  it("falls back to UTC for a historical offset that is not a whole minute", () => {
    // Africa/Cairo local mean time before 1900 was +02:05:09.
    expect(formatInstantInZone(new Date("1890-01-01T00:00:00Z"), "Africa/Cairo")).toBe("1890-01-01T00:00:00Z");
  });

  it("round-trips: the printed instant is the same instant", () => {
    for (const iso of ["2026-03-08T07:00:00Z", "2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z", "2027-01-01T00:00:00Z"]) {
      const d = new Date(iso);
      expect(new Date(formatInstantInZone(d, "America/New_York")).getTime()).toBe(d.getTime());
    }
  });
});
