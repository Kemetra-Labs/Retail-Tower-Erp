/**
 * RT-1530 — the pure core of `publicationStatus` (spec 042 §3): a row's activation instant read in
 * the Store's live zone, the membership floor of a Zone line, and `scheduled` / `active`.
 */
import {
  activationMs,
  publicationStatuses,
  statusAt,
  type ActivationRow,
} from "../../src/pricing/change-sets/price-change-set-publication-status";

const ms = (iso: string): number => Date.parse(iso);
const local = (wall: string, over: Partial<ActivationRow> = {}): ActivationRow => ({
  setId: "s",
  storeId: "x",
  timeBasis: "store_local",
  scope: "store",
  wall: new Date(`${wall}Z`),
  storedMs: ms("2090-06-01T12:00:00Z"),
  ...over,
});

describe("activationMs", () => {
  it("keeps an absolute row's stored instant whatever the zone", () => {
    const row = local("2090-06-01T12:00", { timeBasis: "absolute", wall: null });
    expect(activationMs(row, "Asia/Tokyo", undefined)).toBe(row.storedMs);
  });

  it("reads a store_local wall clock in the live zone", () => {
    expect(activationMs(local("2090-06-01T12:00"), "UTC", "UTC")).toBe(ms("2090-06-01T12:00:00Z"));
    expect(activationMs(local("2090-06-01T12:00"), "Asia/Tokyo", "UTC")).toBe(ms("2090-06-01T03:00:00Z"));
    expect(activationMs(local("2090-06-01T12:00"), "Pacific/Honolulu", "UTC")).toBe(ms("2090-06-01T22:00:00Z"));
  });

  it("applies the Q-2 DST rule: a gap resolves to the transition", () => {
    // Cairo skips 00:00-01:00 on 2031-04-25 (the same case the publish spec uses): 01:00 EEST.
    expect(activationMs(local("2031-04-25T00:15"), "Africa/Cairo", undefined)).toBe(ms("2031-04-24T22:00:00Z"));
  });

  it("keeps a binding membership start as a floor under a Zone line, and ignores one that had started", () => {
    const bound = local("2090-06-01T12:00", { scope: "zone", storedMs: ms("2090-06-05T00:00:00Z") });
    // Stored later than the line's start in the validated zone: the membership start binds.
    expect(activationMs(bound, "Asia/Tokyo", "UTC")).toBe(ms("2090-06-05T00:00:00Z"));
    const started = local("2090-06-01T12:00", { scope: "zone", storedMs: ms("2090-06-01T12:00:00Z") });
    expect(activationMs(started, "Asia/Tokyo", "UTC")).toBe(ms("2090-06-01T03:00:00Z"));
    // The floor never applies to a Book or Store line.
    expect(activationMs({ ...bound, scope: "book" }, "Asia/Tokyo", "UTC")).toBe(ms("2090-06-01T03:00:00Z"));
  });

  it("keeps the stored instant when the zone is not readable", () => {
    expect(activationMs(local("2090-06-01T12:00"), "Not/AZone", undefined)).toBe(ms("2090-06-01T12:00:00Z"));
  });
});

describe("statusAt", () => {
  it("is scheduled before the earliest instant and active from it, and active with nothing to wait for", () => {
    expect(statusAt(ms("2090-01-01T00:00:00Z"), ms("2089-12-31T23:59:59Z"))).toBe("scheduled");
    expect(statusAt(ms("2090-01-01T00:00:00Z"), ms("2090-01-01T00:00:00Z"))).toBe("active");
    expect(statusAt(null, 0)).toBe("active");
  });
});

describe("publicationStatuses", () => {
  it("reads nothing for no sets", async () => {
    const query = jest.fn();
    expect((await publicationStatuses({ query }, "t", 0, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
