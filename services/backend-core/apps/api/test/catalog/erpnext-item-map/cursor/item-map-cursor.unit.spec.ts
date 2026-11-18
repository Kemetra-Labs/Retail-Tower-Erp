/**
 * RT-1458 (A-17) — the opaque keyset cursor of `tenantAdminListErpnextItemMappings`.
 * Pure: no DB, no clock. The cursor carries `(suggested_at, id)` where `suggested_at` is the
 * microsecond-precision UTC text Postgres produced (a JS Date would drop the microseconds and
 * skip or repeat rows that share a millisecond).
 */
import { encodeOpaque } from "../../../../src/common/cursor/opaque-cursor";
import {
  decodeItemMapCursor,
  encodeItemMapCursor,
  InvalidItemMapCursorError,
} from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.cursor";

const KEY = "2026-11-18T10:15:30.123456Z";
const ID = "0a000000-0000-7000-8000-00000d013c11";

describe("erpnext-item-map cursor codec (RT-1458)", () => {
  it("round-trips (suggested_at key, id) with microsecond precision", () => {
    const token = encodeItemMapCursor(KEY, ID);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeItemMapCursor(token)).toEqual({ suggestedAtKey: KEY, id: ID });
  });

  it.each([
    ["not base64url JSON", "%%%"],
    ["base64url of non-JSON text", Buffer.from("hello", "utf8").toString("base64url")],
    ["a JSON array", Buffer.from("[1,2]", "utf8").toString("base64url")],
    ["JSON null", Buffer.from("null", "utf8").toString("base64url")],
    ["missing id", encodeOpaque({ s: KEY })],
    ["missing key", encodeOpaque({ i: ID })],
    ["an extra field", encodeOpaque({ s: KEY, i: ID, x: 1 })],
    ["a millisecond-precision key", encodeOpaque({ s: "2026-11-18T10:15:30.123Z", i: ID })],
    ["a key that is not a calendar instant (Feb 31)", encodeOpaque({ s: "2026-02-31T10:15:30.123456Z", i: ID })],
    ["a non-uuid id", encodeOpaque({ s: KEY, i: "not-a-uuid" })],
    ["an empty string", ""],
  ])("rejects %s", (_name, token) => {
    expect(() => decodeItemMapCursor(token)).toThrow(InvalidItemMapCursorError);
  });
});
