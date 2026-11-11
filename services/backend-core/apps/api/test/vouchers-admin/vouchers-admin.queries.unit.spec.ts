/**
 * RT-1108 — the keyset cursor and the SQL contracts of the voucher reads.
 * Docker-free. The cursor must not depend on the process time zone (the first
 * draft emitted a zone-less timestamp that `Date.parse` read as local time).
 */
import {
  authoritySql,
  decodeVoucherCursor,
  encodeVoucherCursor,
  GET_SQL,
  InvalidVoucherCursorError,
  LIST_SQL,
} from "../../src/vouchers-admin/vouchers-admin.queries";

const ID = "0a000000-0000-7000-8000-0000011082a1";
const KEY = "2026-11-11T10:00:00.123456Z";

describe("voucher cursor", () => {
  const original = process.env["TZ"];
  afterEach(() => {
    if (original === undefined) delete process.env["TZ"];
    else process.env["TZ"] = original;
  });

  it.each(["UTC", "Africa/Cairo", "America/Los_Angeles", "Asia/Kolkata"])("round-trips under TZ=%s", (tz) => {
    process.env["TZ"] = tz;
    expect(decodeVoucherCursor(encodeVoucherCursor(KEY, ID))).toEqual({ createdAtKey: KEY, voucherId: ID });
  });

  it("round-trips a key near a DST edge under Africa/Cairo", () => {
    process.env["TZ"] = "Africa/Cairo";
    const edge = "2026-04-23T22:30:00.000001Z";
    expect(decodeVoucherCursor(encodeVoucherCursor(edge, ID)).createdAtKey).toBe(edge);
  });

  it.each([
    ["a zone-less key", encodeVoucherCursor("2026-11-11T10:00:00.123456", ID)],
    ["a key with millisecond precision", encodeVoucherCursor("2026-11-11T10:00:00.123Z", ID)],
    ["an impossible date", encodeVoucherCursor("2026-02-31T00:00:00.000000Z", ID)],
    ["a non-uuid id", encodeVoucherCursor(KEY, "x")],
    ["text that is not a cursor", "not-a-cursor"],
    ["an extra field", Buffer.from(JSON.stringify({ c: KEY, i: ID, x: 1 })).toString("base64url")],
  ])("refuses %s", (_label, raw) => {
    expect(() => decodeVoucherCursor(raw)).toThrow(InvalidVoucherCursorError);
  });
});

describe("voucher read SQL", () => {
  it("selects no code and no hash", () => {
    for (const sql of [GET_SQL, LIST_SQL]) expect(sql).not.toMatch(/code_hash|\bcode\b/);
  });

  it("compares the cursor as timestamptz, not as zone-less text", () => {
    expect(LIST_SQL).toContain("$7::timestamptz");
    expect(LIST_SQL).toContain('HH24:MI:SS.US"Z"');
  });

  it("keeps the store authority in the predicate (all-stores vouchers need tenant-wide scope)", () => {
    const sql = authoritySql("$3", "$4");
    expect(sql).toContain("$3::boolean");
    expect(sql).toContain("NOT v.applies_to_all_stores");
    expect(sql).toContain("$4::uuid[]");
    expect(GET_SQL).toContain(sql);
  });
});
