/**
 * RT-1213: the shared opaque keyset-cursor codec (src/common/cursor/opaque-cursor.ts).
 */
import { z } from "zod";

import { InvalidCursorError, decodeOpaque, encodeOpaque, isCalendarInstant } from "../../src/common/cursor/opaque-cursor";

class TestCursorError extends InvalidCursorError {
  constructor() {
    super();
    this.name = "TestCursorError";
  }
}

const Schema = z.object({ k: z.literal("test"), n: z.number().int() }).strict();
const invalid = (): Error => new TestCursorError();
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

describe("encodeOpaque", () => {
  it("is base64url of the JSON, keys in insertion order, no padding", () => {
    expect(encodeOpaque({ k: "test", n: 1 })).toBe(b64('{"k":"test","n":1}'));
    expect(encodeOpaque({ n: 1, k: "test" })).toBe(b64('{"n":1,"k":"test"}'));
    expect(encodeOpaque({ k: "test", n: 1 })).not.toMatch(/[=+/]/);
  });
});

describe("decodeOpaque", () => {
  it("returns the validated payload", () => {
    expect(decodeOpaque(encodeOpaque({ k: "test", n: 7 }), Schema, invalid)).toEqual({ k: "test", n: 7 });
  });

  it.each([
    ["not base64 JSON", "***"],
    ["empty", ""],
    ["not JSON", b64("nope")],
    ["schema failure", b64('{"k":"other","n":1}')],
    ["extra key under a strict schema", b64('{"k":"test","n":1,"x":2}')],
  ])("throws the caller's error for %s", (_label, raw) => {
    expect(() => decodeOpaque(raw, Schema, invalid)).toThrow(TestCursorError);
  });

  it("calls onInvalid only on failure, and only once", () => {
    const onInvalid = jest.fn((): Error => new TestCursorError());
    decodeOpaque(encodeOpaque({ k: "test", n: 1 }), Schema, onInvalid);
    expect(onInvalid).toHaveBeenCalledTimes(0);
    expect(() => decodeOpaque(b64("nope"), Schema, onInvalid)).toThrow(TestCursorError);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(() => decodeOpaque(b64('{"k":"other","n":1}'), Schema, onInvalid)).toThrow(TestCursorError);
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });
});

describe("InvalidCursorError", () => {
  it("has the shared default message, and subclasses keep their own name", () => {
    const base = new InvalidCursorError();
    expect(base.message).toBe("cursor is not a valid continuation token for this operation");
    expect(base.name).toBe("InvalidCursorError");
    const sub = new TestCursorError();
    expect(sub).toBeInstanceOf(InvalidCursorError);
    expect(sub.name).toBe("TestCursorError");
  });
});

describe("isCalendarInstant", () => {
  it("accepts a real UTC instant", () => {
    expect(isCalendarInstant("2026-03-04T05:06:07.123456Z")).toBe(true);
    expect(isCalendarInstant("2024-02-29T23:59:59.999999Z")).toBe(true);
  });

  it.each([
    ["a day that rolls over", "2026-02-31T05:06:07.123456Z"],
    ["hour 24", "2026-03-04T24:00:00.000000Z"],
    ["a non-leap Feb 29", "2026-02-29T00:00:00.000000Z"],
    ["text", "not-a-date"],
    ["empty", ""],
  ])("refuses %s", (_label, key) => {
    expect(isCalendarInstant(key)).toBe(false);
  });
});
