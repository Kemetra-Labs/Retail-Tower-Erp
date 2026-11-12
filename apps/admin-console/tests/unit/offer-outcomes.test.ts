import { classifyBrandWrite, validateBrandName } from "@/brands/brandLogic";
import { KeyedAttempt, errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";
import { classifyOfferResult, issueKey, noticeOf } from "@/offers/offerOutcomes";
import { buildSimulation } from "@/offers/offerSimulationLogic";
import { describe, expect, test } from "vitest";
import { OFFER_ID } from "./offer-fixtures";

/**
 * RT-1338: what each answer of an offers or brands write does. Every offer write is replayable under
 * its Idempotency-Key, so the key is held through an unclear answer and dropped on a terminal one.
 */

const err = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  status,
  error: { error: { code, message: "server words", request_id: "req-1", ...extra } },
});

describe("classifyOfferResult", () => {
  test("a 2xx with a body is ok", () => {
    expect(classifyOfferResult({ status: 200, data: { offerId: OFFER_ID } })).toEqual({
      kind: "ok",
      data: { offerId: OFFER_ID },
    });
  });

  test("409 offer_conflict carries the conflicts list (OD-7)", () => {
    const conflicts = [
      { offerId: "x", offerVersion: 1, nameAr: "ع", state: "active", sharedProductCount: 3 },
    ];
    expect(classifyOfferResult(err(409, "offer_conflict", { conflicts }))).toEqual({
      kind: "conflict",
      conflicts,
      requestId: "req-1",
    });
  });

  test("409 draft changed and 409 state invalid are both stale views (the offer is read again)", () => {
    expect(classifyOfferResult(err(409, "offer_draft_changed_concurrently")).kind).toBe("stale");
    expect(classifyOfferResult(err(409, "offer_state_invalid"))).toMatchObject({
      kind: "stale",
      stateInvalid: true,
    });
  });

  test("422 names its reason in catalog copy, never the server's words", () => {
    for (const code of [
      "offer_reference_invalid",
      "offer_eligible_set_empty",
      "offer_eligible_set_too_large",
      "offer_schedule_elapsed",
      "offer_store_offer_limit_exceeded",
    ]) {
      expect(classifyOfferResult(err(422, code))).toMatchObject({
        kind: "failed",
        messageKey: issueKey(code),
        keepKey: false,
      });
    }
    expect(classifyOfferResult(err(422, "offer_store_not_in_scope"))).toMatchObject({
      messageKey: "offers.error.storeNotInScope",
    });
  });

  test("403 and 404 are told apart; origin and store variants have their own words", () => {
    expect(classifyOfferResult(err(403, "forbidden"))).toMatchObject({
      messageKey: "offers.error.forbidden",
    });
    expect(classifyOfferResult(err(403, "origin_rejected"))).toMatchObject({
      messageKey: "offers.error.origin",
    });
    expect(classifyOfferResult(err(404, "offer_not_found"))).toMatchObject({
      messageKey: "offers.error.notFound",
    });
    expect(classifyOfferResult(err(404, "store_not_found"))).toMatchObject({
      messageKey: "offers.error.storeNotFound",
    });
  });

  test("425, 429 and a 5xx keep the key (the write may not have landed); a 400 and a 401 drop it", () => {
    expect(classifyOfferResult(err(425, "x"))).toMatchObject({
      messageKey: "offers.error.uncertain",
      keepKey: true,
    });
    expect(classifyOfferResult(err(503, "x"))).toMatchObject({
      messageKey: "offers.error.uncertain",
      keepKey: true,
    });
    expect(classifyOfferResult(err(429, "rate_limited"))).toMatchObject({
      messageKey: "offers.error.rateLimited",
      keepKey: true,
    });
    expect(classifyOfferResult(err(400, "validation_error"))).toMatchObject({ keepKey: false });
    expect(classifyOfferResult(err(401, "unauthorized"))).toMatchObject({
      messageKey: "offers.error.session",
    });
  });

  test("an unknown issue code reads as generic", () => {
    expect(issueKey("brand_new_code")).toBe("offers.issue.unknown");
  });
});

describe("noticeOf", () => {
  test("a success, a stale draft, a conflict and an unclear answer each get their banner", () => {
    expect(noticeOf({ kind: "ok", data: 1 }, "offers.save.done")).toEqual({
      variant: "success",
      messageKey: "offers.save.done",
    });
    expect(noticeOf({ kind: "stale" }, "offers.save.done")).toMatchObject({ variant: "warning" });
    expect(noticeOf({ kind: "stale", stateInvalid: true }, "offers.save.done").messageKey).toBe(
      "offers.error.stateInvalid",
    );
    expect(noticeOf({ kind: "conflict", conflicts: [] }, "offers.save.done")).toMatchObject({
      variant: "danger",
      messageKey: "offers.error.conflict",
    });
    expect(
      noticeOf(
        { kind: "failed", messageKey: "offers.error.uncertain", keepKey: true },
        "offers.save.done",
      ),
    ).toMatchObject({ variant: "warning" });
  });
});

describe("KeyedAttempt: one Idempotency-Key per intended action", () => {
  test("the same body keeps its key until a terminal answer; another body takes a new one", () => {
    const attempt = new KeyedAttempt();
    const first = attempt.keyFor("a");
    expect(attempt.keyFor("a")).toBe(first);
    expect(attempt.keyFor("b")).not.toBe(first);
    const second = attempt.keyFor("b");
    attempt.settle();
    expect(attempt.keyFor("b")).not.toBe(second);
    expect(attempt.keyFor("b")).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("the error envelope's code and request id are read, and absent ones are undefined", () => {
    expect(errorCodeOf({ error: { code: "c", request_id: "r" } })).toBe("c");
    expect(errorRequestIdOf({ error: { code: "c", request_id: "r" } })).toBe("r");
    expect(errorCodeOf(undefined)).toBeUndefined();
    expect(errorCodeOf({ error: "idempotency_in_progress" })).toBeUndefined();
  });
});

describe("buildSimulation: exact decimal strings, rendered by the server", () => {
  test("lines go out as price strings with a quantity, in the currency", () => {
    expect(
      buildSimulation(
        [
          { unitPrice: "100", quantity: "1" },
          { unitPrice: "٥٠٫٥٠", quantity: "" },
        ],
        "EGP",
      ),
    ).toEqual({
      ok: true,
      request: {
        currencyCode: "EGP",
        lines: [
          { unitPrice: "100", quantity: 1 },
          { unitPrice: "50.50", quantity: 1 },
        ],
      },
    });
  });

  test("a price with more than four decimals or letters, and a quantity outside 1 to 999, are refused", () => {
    const result = buildSimulation(
      [
        { unitPrice: "1.23456", quantity: "1" },
        { unitPrice: "10", quantity: "1000" },
        { unitPrice: "ten", quantity: "1" },
      ],
      "EGP",
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.errors.map((e) => Object.keys(e ?? {}))).toEqual([
      ["unitPrice"],
      ["quantity"],
      ["unitPrice"],
    ]);
    expect(buildSimulation([], "EGP")).toMatchObject({
      ok: false,
      form: "offers.sim.error.noLines",
    });
  });
});

describe("brands (RT-1334 contract)", () => {
  test("a name is required, trimmed, and at most 200 characters", () => {
    expect(validateBrandName("   ")).toBe("brands.form.nameRequired");
    expect(validateBrandName("x".repeat(201))).toBe("brands.form.nameTooLong");
    expect(validateBrandName("  Nike ")).toBeUndefined();
  });

  test("create and rename answers: a name clash returns to the field; stale and gone reload; a 5xx keeps the key", () => {
    const brand = { brandId: "b1", name: "Nike", updatedAt: "2026-11-12T10:00:00Z" };
    expect(classifyBrandWrite({ status: 201, data: brand }, "create")).toEqual({
      kind: "ok",
      brand,
    });
    expect(classifyBrandWrite(err(409, "brand_name_conflict"), "create")).toMatchObject({
      kind: "nameTaken",
    });
    expect(classifyBrandWrite(err(409, "stale_write"), "rename")).toMatchObject({ kind: "stale" });
    expect(classifyBrandWrite(err(404, "not_found"), "rename")).toMatchObject({ kind: "gone" });
    // A create 404 is the role refusal, never "the brand vanished".
    expect(classifyBrandWrite(err(404, "not_found"), "create")).toMatchObject({
      kind: "failed",
      messageKey: "brands.write.error.forbidden",
    });
    expect(classifyBrandWrite(err(500, "x"), "create")).toMatchObject({ kind: "uncertain" });
    expect(classifyBrandWrite(err(429, "rate_limited"), "create")).toMatchObject({
      kind: "failed",
      messageKey: "brands.write.error.rateLimited",
    });
  });
});
