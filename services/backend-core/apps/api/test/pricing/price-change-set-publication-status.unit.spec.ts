/**
 * RT-1530 — the pure core of `publicationStatus` (spec 042 §3): a group's activation instant read in
 * the Store's live zone, the membership start of a Zone line, the stored-instant fallback of a Store
 * that is not live, and `scheduled` / `active`.
 */
import {
  activationMs,
  publicationStatuses,
  statusAt,
  type LocalGroup,
  type MembershipSpan,
} from "../../src/pricing/change-sets/price-change-set-publication-status";

const ms = (iso: string): number => Date.parse(iso);
const group = (wall: string, over: Partial<LocalGroup> = {}): LocalGroup => ({
  setId: "s",
  storeId: "x",
  scope: "store",
  zoneId: null,
  zoneIsDefault: false,
  wall: new Date(`${wall}Z`),
  storedMs: ms("2090-06-01T12:00:00Z"),
  ...over,
});
const span = (from: string, to?: string): MembershipSpan => ({ fromMs: ms(from), toMs: to === undefined ? null : ms(to) });

describe("activationMs", () => {
  it("reads a store_local wall clock in the live zone", () => {
    expect(activationMs(group("2090-06-01T12:00"), "UTC", [])).toBe(ms("2090-06-01T12:00:00Z"));
    expect(activationMs(group("2090-06-01T12:00"), "Asia/Tokyo", [])).toBe(ms("2090-06-01T03:00:00Z"));
    expect(activationMs(group("2090-06-01T12:00"), "Pacific/Honolulu", [])).toBe(ms("2090-06-01T22:00:00Z"));
  });

  it("applies the Q-2 DST rule: a gap resolves to the transition", () => {
    // Cairo skips 00:00-01:00 on 2031-04-25 (the same case the publish spec uses): 01:00 EEST.
    expect(activationMs(group("2031-04-25T00:15"), "Africa/Cairo", [])).toBe(ms("2031-04-24T22:00:00Z"));
  });

  it("keeps the stored instant for a Store that is not live (deleted or deactivated)", () => {
    expect(activationMs(group("2090-06-01T12:00"), undefined, [])).toBe(ms("2090-06-01T12:00:00Z"));
    expect(activationMs(group("2090-06-01T09:00", { storedMs: ms("2090-06-01T07:00:00Z") }), undefined, [])).toBe(ms("2090-06-01T07:00:00Z"));
  });

  it("keeps the stored instant when the live zone is not readable", () => {
    expect(activationMs(group("2090-06-01T12:00"), "Not/AZone", [])).toBe(ms("2090-06-01T12:00:00Z"));
  });

  describe("a Zone line waits for the Store's membership", () => {
    const zone = (over: Partial<LocalGroup> = {}) => group("2090-06-01T12:00", { scope: "zone", zoneId: "z", ...over });

    it("m1: a membership that started before the validated line start still floors a zone change that moves the line earlier", () => {
      // Validated in UTC (12:00Z), membership from 10:00Z, the Store moves to Tokyo (line 03:00Z).
      expect(activationMs(zone(), "Asia/Tokyo", [span("2090-06-01T10:00:00Z")])).toBe(ms("2090-06-01T10:00:00Z"));
    });

    it("a membership that starts after the line start binds; one that started long before does not", () => {
      expect(activationMs(zone(), "UTC", [span("2090-06-05T00:00:00Z")])).toBe(ms("2090-06-05T00:00:00Z"));
      expect(activationMs(zone(), "Asia/Tokyo", [span("2080-01-01T00:00:00Z")])).toBe(ms("2090-06-01T03:00:00Z"));
    });

    it("takes the earliest start over the memberships that end after the line start", () => {
      const spans = [span("2090-05-01T00:00:00Z", "2090-05-20T00:00:00Z"), span("2090-06-03T00:00:00Z"), span("2090-06-02T00:00:00Z", "2090-06-04T00:00:00Z")];
      expect(activationMs(zone(), "UTC", spans)).toBe(ms("2090-06-02T00:00:00Z"));
    });

    it("never applies to a Book or Store line, nor to the Book's default Zone (the fallback)", () => {
      const spans = [span("2090-06-05T00:00:00Z")];
      expect(activationMs(zone({ scope: "book" }), "Asia/Tokyo", spans)).toBe(ms("2090-06-01T03:00:00Z"));
      expect(activationMs(zone({ scope: "store" }), "Asia/Tokyo", spans)).toBe(ms("2090-06-01T03:00:00Z"));
      expect(activationMs(zone({ zoneIsDefault: true }), "Asia/Tokyo", spans)).toBe(ms("2090-06-01T03:00:00Z"));
    });

    it("keeps the stored instant for a Store that is not live, whatever its memberships", () => {
      expect(activationMs(zone({ storedMs: ms("2090-06-01T07:00:00Z") }), undefined, [span("2090-06-05T00:00:00Z")])).toBe(ms("2090-06-01T07:00:00Z"));
    });
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
  const SET = { id: "00000000-0000-0000-0000-000000000001", version: 1, revisionNo: 2 };

  /** A client answering the statements by their first words: grouped local rows, absolute minima, Stores. */
  function client(opts: { local: Record<string, unknown>[]; absolute?: Record<string, unknown>[]; stores: Record<string, unknown>[] }) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM stores")) return { rows: opts.stores };
      if (sql.includes("price_zone_memberships m\n      WHERE")) return { rows: [] };
      if (sql.includes("l.time_basis = 'absolute'")) return { rows: opts.absolute ?? [] };
      return { rows: opts.local };
    });
    return { query } as unknown as Parameters<typeof publicationStatuses>[0];
  }
  const local = (storeId: string, wall: string, storedAt: string) => ({
    set_id: SET.id,
    store_id: storeId,
    scope: "store",
    zone_id: null,
    zone_is_default: false,
    wall,
    stored_at: new Date(storedAt),
  });

  it("reads nothing for no sets", async () => {
    const query = jest.fn();
    expect((await publicationStatuses({ query }, "t", 0, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("a deactivated or deleted Store keeps its stored instant; a live Store follows its zone", async () => {
    const wall = "2090-06-01T12:00:00.000";
    const rows = [local("live", wall, "2090-06-01T12:00:00Z"), local("gone", wall, "2090-06-01T03:00:00Z")];
    const stores = (liveTz: string) => [
      { id: "live", timezone: liveTz, live: true },
      { id: "gone", timezone: "Pacific/Auckland", live: false },
    ];
    const at = (iso: string) => Date.parse(iso);
    // Live Store at 12:00Z, the gone Store at its stored 03:00Z: active from 03:00Z, whatever its zone is now.
    const early = await publicationStatuses(client({ local: rows, stores: stores("UTC") }), "t", at("2090-06-01T04:00:00Z"), [SET]);
    expect(early.get(SET.id)).toBe("active");
    const before = await publicationStatuses(client({ local: rows, stores: stores("UTC") }), "t", at("2090-06-01T02:00:00Z"), [SET]);
    expect(before.get(SET.id)).toBe("scheduled");
    // The live Store moves west of the stored instant: the gone Store still holds the minimum.
    const moved = await publicationStatuses(client({ local: rows, stores: stores("Pacific/Honolulu") }), "t", at("2090-06-01T04:00:00Z"), [SET]);
    expect(moved.get(SET.id)).toBe("active");
  });

  it("an absolute minimum and a set with no rows", async () => {
    const abs = await publicationStatuses(
      client({ local: [], absolute: [{ set_id: SET.id, at: new Date("2090-01-01T00:00:00Z") }], stores: [] }),
      "t",
      Date.parse("2089-12-31T00:00:00Z"),
      [SET],
    );
    expect(abs.get(SET.id)).toBe("scheduled");
    expect((await publicationStatuses(client({ local: [], stores: [] }), "t", 0, [SET])).get(SET.id)).toBe("active");
  });
});
