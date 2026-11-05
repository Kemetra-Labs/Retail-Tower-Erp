/**
 * RT-1213: golden characterization of the device-health keyset cursor, written against the
 * pre-refactor codec so the move onto the shared opaque-cursor helper cannot change a byte.
 * Pins the exact token for a fixed payload (key order k, t, d; both ids lowercased), that
 * existing tokens still decode, and every refusal: each is InvalidDeviceHealthCursorError,
 * which the controller maps to 400 `validation_error`.
 */
import { InvalidCursorError } from "../../src/common/cursor/opaque-cursor";
import {
  InvalidDeviceHealthCursorError,
  decodeDeviceHealthCursor,
  encodeDeviceHealthCursor,
} from "../../src/device-health/device-health.projections";

const TENANT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_TENANT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const DEVICE = "0190f0e1-d2c3-7b4a-9f8e-7d6c5b4a3f2e";

// base64url of {"k":"device_health","t":"<TENANT>","d":"<DEVICE>"}, no padding.
const TOKEN =
  "eyJrIjoiZGV2aWNlX2hlYWx0aCIsInQiOiIwMTkwYTFiMi1jM2Q0LTdlNWYtOGE5Yi0wYzFkMmUzZjRhNWIiLCJkIjoiMDE5MGYwZTEtZDJjMy03YjRhLTlmOGUtN2Q2YzViNGEzZjJlIn0";

const b64 = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");

describe("encodeDeviceHealthCursor (golden)", () => {
  it("produces the exact token for a fixed payload", () => {
    expect(encodeDeviceHealthCursor({ tenantId: TENANT, deviceId: DEVICE })).toBe(TOKEN);
  });

  it("lowercases both ids, so mixed-case input gives the same bytes", () => {
    expect(encodeDeviceHealthCursor({ tenantId: TENANT.toUpperCase(), deviceId: DEVICE.toUpperCase() })).toBe(TOKEN);
  });

  it("keeps the payload key order k, t, d", () => {
    expect(Buffer.from(TOKEN, "base64url").toString("utf8")).toBe(`{"k":"device_health","t":"${TENANT}","d":"${DEVICE}"}`);
  });
});

describe("decodeDeviceHealthCursor (golden)", () => {
  it("decodes an existing token to its device id", () => {
    expect(decodeDeviceHealthCursor({ tenantId: TENANT, cursor: TOKEN })).toBe(DEVICE);
  });

  it("accepts the tenant id in upper case (it is lowercased before the check)", () => {
    expect(decodeDeviceHealthCursor({ tenantId: TENANT.toUpperCase(), cursor: TOKEN })).toBe(DEVICE);
  });

  it("round-trips", () => {
    const cursor = encodeDeviceHealthCursor({ tenantId: TENANT, deviceId: DEVICE });
    expect(decodeDeviceHealthCursor({ tenantId: TENANT, cursor })).toBe(DEVICE);
  });

  it.each([
    ["not base64 JSON", "***"],
    ["empty string", ""],
    ["not JSON", b64("not json")],
    ["an empty object", b64({})],
    ["a JSON array", b64([TENANT, DEVICE])],
    ["JSON null", b64("null")],
    ["another operation's kind", b64({ k: "devices", t: TENANT, d: DEVICE })],
    ["an extra key (strict schema)", b64({ k: "device_health", t: TENANT, d: DEVICE, x: 1 })],
    ["a missing device id", b64({ k: "device_health", t: TENANT })],
    ["an upper-case device id inside the token", b64({ k: "device_health", t: TENANT, d: DEVICE.toUpperCase() })],
    ["an upper-case tenant id inside the token", b64({ k: "device_health", t: TENANT.toUpperCase(), d: DEVICE })],
    ["a device id that is not a UUID", b64({ k: "device_health", t: TENANT, d: "device-1" })],
  ])("refuses %s", (_label, cursor) => {
    expect(() => decodeDeviceHealthCursor({ tenantId: TENANT, cursor })).toThrow(InvalidDeviceHealthCursorError);
  });

  it("refuses a token issued for another tenant", () => {
    expect(() => decodeDeviceHealthCursor({ tenantId: OTHER_TENANT, cursor: TOKEN })).toThrow(InvalidDeviceHealthCursorError);
  });
});

describe("InvalidDeviceHealthCursorError", () => {
  it("keeps its name and message", () => {
    let caught: unknown;
    try {
      decodeDeviceHealthCursor({ tenantId: OTHER_TENANT, cursor: TOKEN });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidDeviceHealthCursorError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("InvalidDeviceHealthCursorError");
    expect((caught as Error).message).toBe("cursor is not a valid continuation token for this operation");
  });

  it("extends the shared InvalidCursorError base (RT-1213)", () => {
    expect(new InvalidDeviceHealthCursorError()).toBeInstanceOf(InvalidCursorError);
  });
});
