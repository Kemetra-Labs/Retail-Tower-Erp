import { translate } from "@/i18n";
import { isRetryable, loadFailureOf, serverErrorKey } from "@/lib/error-recovery";
import { mapSalesByStoreError } from "@/lib/sales-by-store-queries";
import { mapSalesSummaryError } from "@/lib/sales-summary-queries";
import { describe, expect, test } from "vitest";

/**
 * RT-965: the one answer to "can retrying help?". The Console has no backend retry registry, so
 * this mapping is drafted from the status family and the documented settled-refusal codes.
 */
const RETRY_WORDS = {
  en: /try again|retry(?!ing will not)/i,
  ar: /حاول مرة أخرى|إعادة المحاولة(?! لن)/,
} as const;

describe("isRetryable", () => {
  test.each([
    [undefined, true],
    [0, true],
    [500, true],
    [502, true],
    [503, true],
    [408, true],
    [425, true],
    [429, true],
    [501, false],
    [505, false],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [409, false],
  ])("status %s -> retryable %s", (status, expected) => {
    expect(isRetryable(status)).toBe(expected);
  });

  test.each(["validation", "validation_error", "forbidden", "not_found", "scope_too_large"])(
    "the settled code %s is never retryable, even on a 5xx",
    (code) => {
      expect(isRetryable(500, code)).toBe(false);
      expect(isRetryable(undefined, code)).toBe(false);
    },
  );

  test("an unknown code does not change the status answer", () => {
    expect(isRetryable(503, "something_new")).toBe(true);
    expect(isRetryable(404, "something_new")).toBe(false);
  });
});

describe("loadFailureOf", () => {
  test("no status is the network, retryable, with no reference", () => {
    expect(loadFailureOf(undefined)).toEqual({ cause: "network", retryable: true });
  });

  test("a 500 is the server, retryable, and carries the request id", () => {
    expect(loadFailureOf({ status: 500, error: { error: { request_id: "req-9" } } })).toEqual({
      cause: "server",
      retryable: true,
      requestId: "req-9",
    });
  });

  test("an empty request id is no evidence", () => {
    expect(loadFailureOf({ status: 500, error: { error: { request_id: "" } } }).requestId).toBe(
      undefined,
    );
  });

  test("a 4xx is a refused request and not retryable", () => {
    expect(loadFailureOf({ status: 422 })).toEqual({ cause: "request", retryable: false });
  });
});

describe("serverErrorKey: no error copy recommends a retry for a non-retryable error", () => {
  test("retryable answers keep the retry copy", () => {
    expect(serverErrorKey(500)).toBe("errors.server");
    expect(serverErrorKey(503, "unavailable")).toBe("errors.server");
  });

  test.each([
    [501, undefined],
    [505, undefined],
    [500, "validation_error"],
    [500, "forbidden"],
  ] as const)("status %s / code %s uses the final copy", (status, code) => {
    expect(serverErrorKey(status, code)).toBe("errors.serverFinal");
  });

  test.each(["en", "ar"] as const)("the %s final copy does not say to try again", (locale) => {
    const final = translate(locale, "errors.serverFinal");
    expect(final).not.toMatch(RETRY_WORDS[locale]);
    expect(translate(locale, "errors.load.noRetry")).not.toMatch(RETRY_WORDS[locale]);
  });
});

describe("the 5xx mappers stop recommending a retry when it cannot help", () => {
  test.each([
    ["sales summary", mapSalesSummaryError],
    ["sales by store", mapSalesByStoreError],
  ] as const)("%s", (_name, map) => {
    expect(map({ status: 503 })).toMatchObject({ kind: "server", messageKey: "errors.server" });
    expect(map({ status: 501 })).toMatchObject({
      kind: "generic",
      messageKey: "errors.serverFinal",
    });
  });

  test("a 5xx carrying a settled code is final", () => {
    const error = { error: { code: "forbidden", message: "x" } } as never;
    expect(mapSalesSummaryError({ status: 500, error })).toMatchObject({
      messageKey: "errors.serverFinal",
    });
  });
});
