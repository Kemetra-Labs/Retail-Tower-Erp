import { describe, expect, it } from "vitest";
import { cairoDay, completedDays, dailySeries, traceStats } from "../telemetry";

const MOCKUP = [11, 13, 3, 11, 12, 26, 26, 20, 61, 48, 54, 132, 480, 0];
const FAILS = [2, 2, 0, 1, 2, 0, 1, 1, 2, 0, 1, 3, 2];

describe("cairoDay", () => {
  it("winter (UTC+2): 21:59:59Z is still 12 Nov, 22:00:00Z is 13 Nov", () => {
    expect(cairoDay(new Date("2026-11-12T21:59:59Z"))).toBe("2026-11-12");
    expect(cairoDay(new Date("2026-11-12T22:00:00Z"))).toBe("2026-11-13");
  });

  it("summer (UTC+3, Egypt DST): 20:59:59Z is still 15 Jul, 21:00:00Z is 16 Jul", () => {
    expect(cairoDay(new Date("2026-07-15T20:59:59Z"))).toBe("2026-07-15");
    expect(cairoDay(new Date("2026-07-15T21:00:00Z"))).toBe("2026-07-16");
  });
});

describe("dailySeries", () => {
  const now = new Date("2026-11-13T12:30:00Z"); // 14:30 in Cairo

  it("returns 14 values, oldest first: 13 completed days then today", () => {
    expect(dailySeries([], now)).toEqual(new Array(14).fill(0));
  });

  it("puts a winter timestamp on the right side of the Cairo midnight", () => {
    const series = dailySeries(
      ["2026-11-12T21:59:59Z", "2026-11-12T22:00:00Z", "2026-11-12T22:00:01Z"],
      now,
    );
    expect(series[12]).toBe(1); // 12 Nov: yesterday
    expect(series[13]).toBe(2); // 13 Nov: today, partial
  });

  it("puts a summer timestamp on the right side of the Cairo midnight", () => {
    const summerNow = new Date("2026-07-16T09:00:00Z");
    const series = dailySeries(["2026-07-15T20:59:59Z", "2026-07-15T21:00:00Z"], summerNow);
    expect(series[12]).toBe(1); // 15 Jul
    expect(series[13]).toBe(1); // 16 Jul
  });

  it("counts every timestamp of a busy day (480 runs)", () => {
    const runs = Array.from({ length: 480 }, (_, i) => `2026-11-12T${String(i % 20).padStart(2, "0")}:00:00Z`);
    const series = dailySeries(runs, now);
    expect(series[12]).toBeGreaterThan(0);
    expect(series.reduce((a, b) => a + b, 0)).toBe(480);
  });

  it("drops timestamps older than the window, in the future, or unparseable", () => {
    const series = dailySeries(
      ["2026-10-30T10:00:00Z", "2026-11-14T10:00:00Z", "garbage", "", "2026-11-01T10:00:00Z"],
      now,
    );
    expect(series.reduce((a, b) => a + b, 0)).toBe(1);
    expect(series[1]).toBe(1); // 1 Nov is index 1: window is 31 Oct .. 13 Nov
    expect(series[0]).toBe(0); // 30 Oct is outside; 31 Oct is index 0 and empty
  });

  it("keeps 14 consecutive Cairo days across the late-October DST change", () => {
    const early = new Date("2026-11-02T12:00:00Z");
    // Egypt DST ends on Thu 29 Oct 2026: that Cairo day lasts 25 hours, 21:00Z (28 Oct) to 22:00Z (29 Oct).
    const series = dailySeries(
      [
        "2026-10-28T20:59:59Z", // 28 Oct, still on the previous day
        "2026-10-28T21:00:00Z", // 29 Oct 00:00 (UTC+3)
        "2026-10-29T21:59:59Z", // 29 Oct 23:59 (UTC+2 after the change)
        "2026-10-29T22:00:00Z", // 30 Oct 00:00
      ],
      early,
    );
    expect(series).toHaveLength(14);
    // window: 20 Oct .. 2 Nov, so 28 Oct is index 8, 29 Oct index 9, 30 Oct index 10
    expect(series.slice(7, 12)).toEqual([0, 1, 2, 1, 0]);
  });

  it("honours a custom number of days", () => {
    expect(dailySeries(["2026-11-13T00:00:00Z"], now, 3)).toEqual([0, 0, 1]);
  });
});

describe("completedDays", () => {
  it("drops today and keeps the 13 completed days", () => {
    expect(MOCKUP).toHaveLength(14);
    expect(completedDays(MOCKUP)).toEqual(MOCKUP.slice(0, 13));
  });

  it("does not mutate its input", () => {
    const copy = MOCKUP.slice();
    completedDays(copy);
    expect(copy).toEqual(MOCKUP);
  });
});

describe("traceStats", () => {
  const completed = completedDays(MOCKUP);

  it("count: yesterday 480, 13-day average 69.0, spikes at the last two big days", () => {
    const s = traceStats(completed, "count");
    expect(s.yesterday).toBe(480);
    expect(s.average).toBe(69);
    expect(s.spikes).toContain(11);
    expect(s.spikes).toContain(12);
    expect(s.spikes).toEqual([11, 12]);
  });

  it("count: cap is max(3 x median, 80th percentile, 1) and the band is the interquartile range", () => {
    const s = traceStats(completed, "count");
    expect(s.cap).toBe(78); // median 26 x 3
    expect(s.band).toEqual([12, 54]);
  });

  it("count: today's partial value never moves the figures", () => {
    const withToday = traceStats(completedDays([...completed, 9999]), "count");
    expect(withToday).toEqual(traceStats(completed, "count"));
  });

  it("failures: band is 0 to 2 and the mean is 1.3", () => {
    const s = traceStats(FAILS, "failures");
    expect(s.band).toEqual([0, 2]);
    expect(s.average).toBe(1.3);
    expect(s.yesterday).toBe(2);
  });

  it("failures: no spike markers; cap keeps room for points above the band", () => {
    const s = traceStats(FAILS, "failures");
    expect(s.spikes).toEqual([]);
    expect(s.cap).toBe(4);
    expect(traceStats([0, 0, 9], "failures").cap).toBe(9);
  });

  it("an all-zero series has a cap of at least 1 and no spikes", () => {
    const s = traceStats(new Array(13).fill(0), "count");
    expect(s.cap).toBe(1);
    expect(s.spikes).toEqual([]);
    expect(s.average).toBe(0);
  });

  it("an empty series does not throw", () => {
    const s = traceStats([], "count");
    expect(s).toEqual({ yesterday: 0, average: 0, band: [0, 0], cap: 1, spikes: [] });
  });

  it("does not mutate its input", () => {
    const copy = completed.slice();
    traceStats(copy, "count");
    expect(copy).toEqual(completed);
  });
});
