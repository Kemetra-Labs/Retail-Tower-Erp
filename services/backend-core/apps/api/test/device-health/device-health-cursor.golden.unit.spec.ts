/**
 * RT-1213: golden characterization of the device-health keyset cursor, written against the
 * pre-refactor codec so the move onto the shared opaque-cursor helper cannot change a byte.
 * Pins the exact token for a fixed payload (key order k, t, d; both ids lowercased), that
 * existing tokens still decode, and every refusal: each is InvalidDeviceHealthCursorError,
 * which the controller maps to 400 `validation_error`.
 *
 * The expected token is derived here from the exact JSON text with Node's own base64url, not
 * written as a literal: a base64 literal of `{"k":` looks like a Grafana key to gitleaks, and
 * the full-history scan cannot be allowlisted per line. Byte-for-byte equality still holds,
 * because the JSON text, its key order and the unpadded base64url alphabet are all fixed here.
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

/** The exact payload text a device-health cursor carries for TENANT and DEVICE. */
const PAYLOAD_TEXT = `{"k":"device_health","t":"${TENANT}","d":"${DEVICE}"}`;
const EXPECTED = Buffer.from(PAYLOAD_TEXT, "utf8").toString("base64url");

const b64 = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");

describe("encodeDeviceHealthCursor (golden)", () => {
  it("produces the exact token for a fixed payload", () => {
    const cursor = encodeDeviceHealthCursor({ tenantId: TENANT, deviceId: DEVICE });
    expect(cursor).toBe(EXPECTED);
    // 107 payload bytes -> 143 base64url characters, no padding.
    expect(Buffer.byteLength(PAYLOAD_TEXT, "utf8")).toBe(107);
    expect(cursor).toHaveLength(143);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("lowercases both ids, so mixed-case input gives the same bytes", () => {
    expect(encodeDeviceHealthCursor({ tenantId: TENANT.toUpperCase(), deviceId: DEVICE.toUpperCase() })).toBe(EXPECTED);
  });

  it("carries the payload text exactly, key order k, t, d", () => {
    const cursor = encodeDeviceHealthCursor({ tenantId: TENANT, deviceId: DEVICE });
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe(PAYLOAD_TEXT);
  });
});

describe("decodeDeviceHealthCursor (golden)", () => {
  it("decodes an existing token to its device id", () => {
    expect(decodeDeviceHealthCursor({ tenantId: TENANT, cursor: EXPECTED })).toBe(DEVICE);
  });

  it("accepts the tenant id in upper case (it is lowercased before the check)", () => {
    expect(decodeDeviceHealthCursor({ tenantId: TENANT.toUpperCase(), cursor: EXPECTED })).toBe(DEVICE);
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
    expect(() => decodeDeviceHealthCursor({ tenantId: OTHER_TENANT, cursor: EXPECTED })).toThrow(InvalidDeviceHealthCursorError);
  });
});

describe("InvalidDeviceHealthCursorError", () => {
  it("keeps its name and message", () => {
    let caught: unknown;
    try {
      decodeDeviceHealthCursor({ tenantId: OTHER_TENANT, cursor: EXPECTED });
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
