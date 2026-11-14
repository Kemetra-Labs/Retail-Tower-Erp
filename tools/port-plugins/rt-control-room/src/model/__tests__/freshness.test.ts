import { describe, expect, it } from "vitest";
import { STALE_AFTER_HOURS, sourceFreshness } from "../freshness";

const NOW = new Date("2026-11-13T12:00:00Z");
const hoursAgo = (h: number, extraMin = 0) =>
  new Date(NOW.getTime() - (h * 60 + extraMin) * 60_000).toISOString();

const base = { lastSync: null, newestChange: null, integrationForbidden: false, now: NOW };

describe("sourceFreshness", () => {
  it("is fresh when the newest of sync and change is under 6 hours old", () => {
    const r = sourceFreshness({ ...base, lastSync: hoursAgo(5, 59), newestChange: hoursAgo(20) });
    expect(r.state).toBe("fresh");
    expect(r.lastSync).toBe(hoursAgo(5, 59));
    expect(r.lastChange).toBe(hoursAgo(20));
  });

  it("takes the newer of the two timestamps, whichever field holds it", () => {
    expect(sourceFreshness({ ...base, lastSync: hoursAgo(20), newestChange: hoursAgo(1) }).state).toBe("fresh");
    expect(sourceFreshness({ ...base, lastSync: hoursAgo(1), newestChange: hoursAgo(20) }).state).toBe("fresh");
  });

  it("is stale at 6 hours 1 minute", () => {
    expect(sourceFreshness({ ...base, lastSync: hoursAgo(6, 1), newestChange: hoursAgo(9) }).state).toBe("stale");
    expect(STALE_AFTER_HOURS).toBe(6);
  });

  it("treats exactly 6 hours as still fresh (stale is beyond 6 hours)", () => {
    expect(sourceFreshness({ ...base, newestChange: hoursAgo(6) }).state).toBe("fresh");
  });

  it("is unknown when both are null, never fresh", () => {
    const r = sourceFreshness(base);
    expect(r).toEqual({ state: "unknown", lastChange: null, lastSync: null });
  });

  it("falls back to the newest change when the integration read is forbidden", () => {
    const fresh = sourceFreshness({ ...base, integrationForbidden: true, newestChange: hoursAgo(1) });
    expect(fresh.state).toBe("fresh");
    expect(fresh.lastSync).toBeNull();
    expect(sourceFreshness({ ...base, integrationForbidden: true }).state).toBe("unknown");
  });

  it("ignores a lastSync that was passed while the read is forbidden", () => {
    const r = sourceFreshness({
      ...base,
      integrationForbidden: true,
      lastSync: hoursAgo(1),
      newestChange: hoursAgo(10),
    });
    expect(r.state).toBe("stale");
    expect(r.lastSync).toBeNull();
  });

  it("treats an unparseable timestamp as missing, never as fresh", () => {
    expect(sourceFreshness({ ...base, lastSync: "not a date", newestChange: null }).state).toBe("unknown");
    expect(sourceFreshness({ ...base, lastSync: "nope", newestChange: hoursAgo(1) }).state).toBe("fresh");
  });

  it("does not go stale on a timestamp slightly in the future (clock skew)", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(sourceFreshness({ ...base, newestChange: future }).state).toBe("fresh");
  });
});
