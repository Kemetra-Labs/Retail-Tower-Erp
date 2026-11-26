import { describe, expect, test } from "vitest";

import {
  type ApiResult,
  UUID_PATTERN,
  UUID_PATTERN_LOWERCASE,
  dataOrThrow,
  errorBodyOf,
  errorCodeOf,
  errorCodeStringOf,
  requestIdNonEmptyOf,
  requestIdOf,
  requestIdStringOf,
  statusKindOf,
} from "@/lib/backend-envelope";

const ID = "7c0e8f4a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const envelope = (error: unknown) => ({ error });

/** Bodies a failed call can hand back that are not the contract's shape. */
const NOT_AN_ENVELOPE: unknown[] = [undefined, null, "", "boom", 0, 42, true, [], {}];

describe("errorBodyOf", () => {
  test("returns the inner error object, or undefined when there is none", () => {
    const inner = { code: "x", message: "m", request_id: ID };
    expect(errorBodyOf(envelope(inner))).toBe(inner);
    for (const body of NOT_AN_ENVELOPE) expect(errorBodyOf(body)).toBeUndefined();
  });

  test("passes a non-object inner value through untouched (callers read fields off it)", () => {
    expect(errorBodyOf(envelope("text"))).toBe("text");
    expect(errorBodyOf(envelope(null))).toBeNull();
  });
});

describe("requestIdOf (pass-through)", () => {
  test("reads error.request_id", () => {
    expect(requestIdOf(envelope({ code: "c", message: "m", request_id: ID }))).toBe(ID);
  });

  test("is undefined for a missing envelope, inner object, string inner or absent id", () => {
    for (const body of NOT_AN_ENVELOPE) expect(requestIdOf(body)).toBeUndefined();
    expect(requestIdOf(envelope(undefined))).toBeUndefined();
    expect(requestIdOf(envelope(null))).toBeUndefined();
    expect(requestIdOf(envelope("text"))).toBeUndefined();
    expect(requestIdOf(envelope({ code: "c" }))).toBeUndefined();
  });

  test("hands the id back as the body sent it: empty, null and non-strings are not filtered", () => {
    expect(requestIdOf(envelope({ request_id: "" }))).toBe("");
    expect(requestIdOf(envelope({ request_id: null }))).toBeNull();
    expect(requestIdOf(envelope({ request_id: 7 }))).toBe(7);
  });
});

describe("requestIdStringOf (strings only)", () => {
  test("keeps a string, empty included", () => {
    expect(requestIdStringOf(envelope({ request_id: ID }))).toBe(ID);
    expect(requestIdStringOf(envelope({ request_id: "" }))).toBe("");
  });

  test("drops everything that is not a string", () => {
    for (const body of NOT_AN_ENVELOPE) expect(requestIdStringOf(body)).toBeUndefined();
    for (const id of [null, 7, true, {}, [], undefined]) {
      expect(requestIdStringOf(envelope({ request_id: id }))).toBeUndefined();
    }
    expect(requestIdStringOf(envelope("text"))).toBeUndefined();
    expect(requestIdStringOf(envelope(null))).toBeUndefined();
  });
});

describe("requestIdNonEmptyOf (non-empty strings only)", () => {
  test("keeps a non-empty string", () => {
    expect(requestIdNonEmptyOf(envelope({ request_id: ID }))).toBe(ID);
  });

  test("drops the empty string and everything that is not a string", () => {
    expect(requestIdNonEmptyOf(envelope({ request_id: "" }))).toBeUndefined();
    for (const body of NOT_AN_ENVELOPE) expect(requestIdNonEmptyOf(body)).toBeUndefined();
    for (const id of [null, 7, true, {}, undefined]) {
      expect(requestIdNonEmptyOf(envelope({ request_id: id }))).toBeUndefined();
    }
  });
});

describe("errorCodeOf and errorCodeStringOf", () => {
  test("both read error.code", () => {
    expect(errorCodeOf(envelope({ code: "rate_limited" }))).toBe("rate_limited");
    expect(errorCodeStringOf(envelope({ code: "rate_limited" }))).toBe("rate_limited");
  });

  test("both are undefined without an envelope", () => {
    for (const body of NOT_AN_ENVELOPE) {
      expect(errorCodeOf(body)).toBeUndefined();
      expect(errorCodeStringOf(body)).toBeUndefined();
    }
    expect(errorCodeOf(envelope("text"))).toBeUndefined();
    expect(errorCodeStringOf(envelope(null))).toBeUndefined();
  });

  test("only the string variant filters a non-string code", () => {
    expect(errorCodeOf(envelope({ code: 409 }))).toBe(409);
    expect(errorCodeStringOf(envelope({ code: 409 }))).toBeUndefined();
    expect(errorCodeStringOf(envelope({ code: "" }))).toBe("");
  });
});

describe("UUID patterns", () => {
  const lower = "7c0e8f4a-1b2c-4d5e-8f90-a1b2c3d4e5f6";
  const upper = lower.toUpperCase();

  test("UUID_PATTERN accepts either case", () => {
    expect(UUID_PATTERN.test(lower)).toBe(true);
    expect(UUID_PATTERN.test(upper)).toBe(true);
  });

  test("UUID_PATTERN_LOWERCASE accepts lower case only", () => {
    expect(UUID_PATTERN_LOWERCASE.test(lower)).toBe(true);
    expect(UUID_PATTERN_LOWERCASE.test(upper)).toBe(false);
  });

  test("both are anchored and reject near-misses", () => {
    for (const re of [UUID_PATTERN, UUID_PATTERN_LOWERCASE]) {
      for (const bad of [
        "",
        "not-a-uuid",
        `${lower}0`,
        ` ${lower}`,
        `${lower} `,
        lower.replace(/-/g, ""),
        lower.slice(0, -1),
        lower.replace("7c0e", "zc0e"),
        lower.replace("4d5e", "4d5"),
      ]) {
        expect(re.test(bad)).toBe(false);
      }
    }
  });

  test("neither pattern is global, so test() holds no state between calls", () => {
    expect(UUID_PATTERN.global).toBe(false);
    expect(UUID_PATTERN_LOWERCASE.global).toBe(false);
    expect(UUID_PATTERN.test(lower)).toBe(true);
    expect(UUID_PATTERN.test(lower)).toBe(true);
  });
});

describe("statusKindOf", () => {
  const kinds = { 400: "rejected", 401: "session", 404: "not-found" } as const;

  test("returns the kind of a listed status", () => {
    expect(statusKindOf(kinds, 400)).toBe("rejected");
    expect(statusKindOf(kinds, 401)).toBe("session");
    expect(statusKindOf(kinds, 404)).toBe("not-found");
  });

  test("answers generic for any other status, 0 and 5xx included", () => {
    for (const status of [0, 200, 403, 409, 429, 500, 503]) {
      expect(statusKindOf(kinds, status)).toBe("generic");
    }
  });

  test("answers generic for a status that is not an integer", () => {
    expect(statusKindOf(kinds, Number.NaN)).toBe("generic");
  });
});

describe("dataOrThrow", () => {
  class Boom extends Error {
    constructor(readonly res: ApiResult<unknown>) {
      super("boom");
    }
  }
  const toError = (res: ApiResult<unknown>) => new Boom(res);

  test("returns the payload of a success", () => {
    const data = { items: [1] };
    expect(dataOrThrow({ status: 200, data }, toError)).toBe(data);
    expect(dataOrThrow({ status: 201, data }, toError)).toBe(data);
  });

  test("throws the feature's own error for a 4xx or 5xx, handing it the whole result", () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      const res = {
        status,
        data: { items: [] },
        error: envelope({ request_id: ID }),
        retryAfter: 3,
      };
      let caught: unknown;
      try {
        dataOrThrow(res, toError);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Boom);
      expect((caught as Boom).res).toBe(res);
    }
  });

  test("throws for a success status that carries no body", () => {
    for (const data of [undefined, null, 0, "", false]) {
      expect(() => dataOrThrow({ status: 200, data: data as never }, toError)).toThrow(Boom);
    }
  });

  test("a status below 400 with a body never calls toError", () => {
    let called = false;
    dataOrThrow({ status: 399, data: 1 }, (r) => {
      called = true;
      return toError(r);
    });
    expect(called).toBe(false);
  });
});
