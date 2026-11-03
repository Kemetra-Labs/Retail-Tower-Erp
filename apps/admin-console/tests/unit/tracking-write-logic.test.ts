import {
  buildExpiryCommand,
  buildHoldCommand,
  buildRecallCommand,
  buildReleaseCommand,
  classifyWrite,
  isKeyConflict,
  keyFor,
  refusalHint,
  validateExpiry,
  validateReason,
  validateRecall,
  validateRelease,
} from "@/tracking/writeLogic";
import { describe, expect, test } from "vitest";

/**
 * RT-455 (owner approval, comment 15245): the four governed commands. The fixed
 * reason list, «أخرى» needs a trimmed note, the contract's lengths and counts,
 * no future effective time, the held Idempotency-Key, and an outcome that is a
 * success only on a 200 / 201 with a body (the 404 every command answers until
 * RT-453 is a refusal).
 */
const ID = "0190f000-0000-7000-8000-0000000007b1";
const ID2 = "0190f000-0000-7000-8000-0000000007b2";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";

describe("reason and note", () => {
  test("a reason from the list is required", () => {
    expect(validateReason({ reason: "", note: "" }).reason).toBe("tracking.write.error.reason");
    expect(validateReason({ reason: "supplier_notice", note: "" })).toEqual({});
  });

  test("«أخرى» needs a note that is not blank once trimmed", () => {
    expect(validateReason({ reason: "other", note: "   " }).note).toBe(
      "tracking.write.error.noteRequired",
    );
    expect(validateReason({ reason: "other", note: "  label torn " })).toEqual({});
  });

  test("a note longer than 500 characters is refused before sending", () => {
    expect(validateReason({ reason: "label_misprint", note: "x".repeat(501) }).note).toBe(
      "tracking.write.error.noteLength",
    );
    expect(validateRelease("x".repeat(501)).note).toBe("tracking.write.error.noteLength");
    expect(validateRelease("")).toEqual({});
  });
});

describe("commands", () => {
  test("hold: identity and reason; a blank note is not sent; a note is trimmed", () => {
    expect(buildHoldCommand(ID, { reason: "label_misprint", note: "  " })).toEqual({
      trackingIdentityId: ID,
      reasonCode: "label_misprint",
    });
    expect(buildHoldCommand(ID, { reason: "other", note: " torn " }).note).toBe("torn");
  });

  test("release: an empty body without a note", () => {
    expect(buildReleaseCommand("")).toEqual({});
    expect(buildReleaseCommand(" ok ")).toEqual({ note: "ok" });
  });

  const recall = {
    productId: PRODUCT,
    identityIds: [ID, ID2, ID],
    reason: "authority_notice" as const,
    reference: " EDA-1 ",
    effectiveAt: "",
    note: "",
  };

  test("recall: distinct identities, trimmed reference, no effectiveAt when empty", () => {
    expect(validateRecall(recall)).toEqual({});
    expect(buildRecallCommand(recall)).toEqual({
      tenantProductRef: PRODUCT,
      trackingIdentityIds: [ID, ID2],
      reasonCode: "authority_notice",
      reference: "EDA-1",
    });
  });

  test("recall: 1 to 100 identities, a reference, and no future effective time", () => {
    const now = new Date("2026-11-03T12:00:00");
    expect(validateRecall({ ...recall, identityIds: [] }, now).identities).toBe(
      "tracking.write.error.identities",
    );
    const many = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    expect(validateRecall({ ...recall, identityIds: many }, now).identities).toBe(
      "tracking.write.error.tooMany",
    );
    expect(validateRecall({ ...recall, reference: " " }, now).reference).toBe(
      "tracking.write.error.reference",
    );
    expect(validateRecall({ ...recall, reference: "x".repeat(201) }, now).reference).toBe(
      "tracking.write.error.reference",
    );
    expect(validateRecall({ ...recall, effectiveAt: "2026-11-04T09:00" }, now).effectiveAt).toBe(
      "tracking.write.error.effectiveAt",
    );
    expect(validateRecall({ ...recall, effectiveAt: "2026-11-01T09:00" }, now)).toEqual({});
    expect(buildRecallCommand({ ...recall, effectiveAt: "2026-11-01T09:00" }).effectiveAt).toMatch(
      /^2026-11-0[01]T\d{2}:00:00\.000Z$/,
    );
  });

  test("expiry: a date or null to clear; a malformed date is refused", () => {
    const draft = { date: "2027-03-28", reason: "label_misprint" as const, note: "" };
    expect(validateExpiry(draft)).toEqual({});
    expect(buildExpiryCommand(draft)).toEqual({
      expiryDate: "2027-03-28",
      reasonCode: "label_misprint",
    });
    expect(buildExpiryCommand({ ...draft, date: "" }).expiryDate).toBeNull();
    expect(validateExpiry({ ...draft, date: "28/03/2027" }).date).toBe("tracking.write.error.date");
  });
});

describe("idempotency and outcome", () => {
  test("the key is held while the command is unchanged, and new for another", () => {
    const first = keyFor(null, { a: 1 });
    expect(keyFor(first, { a: 1 })).toBe(first);
    const other = keyFor(first, { a: 2 });
    expect(other.key).not.toBe(first.key);
    expect(first.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("success only on 200 / 201 with a body", () => {
    expect(classifyWrite({ status: 201, data: { hold: {} } })).toEqual({ kind: "recorded" });
    expect(classifyWrite({ status: 200, data: { hold: {} } })).toEqual({ kind: "recorded" });
    expect(classifyWrite({ status: 201 }).kind).toBe("rejected");
  });

  test("the 404 until RT-453 is a refusal with the server's words and a console hint", () => {
    const outcome = classifyWrite({
      status: 404,
      error: { error: { code: "not_found", message: "Not found", request_id: "req-1" } },
    });
    expect(outcome).toEqual({
      kind: "rejected",
      status: 404,
      code: "not_found",
      message: "Not found",
      requestId: "req-1",
      retryAfter: undefined,
    });
    expect(refusalHint(outcome)).toBe("tracking.write.hint.notFound");
  });

  test("known 409 codes, 403, a key conflict, and no hint otherwise", () => {
    const conflict = (code: string) => classifyWrite({ status: 409, error: { error: { code } } });
    expect(refusalHint(conflict("hold_already_active"))).toBe("tracking.write.hint.holdActive");
    expect(refusalHint(conflict("expiry_unchanged"))).toBe("tracking.write.hint.expiryUnchanged");
    expect(isKeyConflict(conflict("idempotency_key_conflict"))).toBe(true);
    expect(refusalHint(classifyWrite({ status: 403 }))).toBe("tracking.write.hint.forbidden");
    expect(refusalHint(classifyWrite({ status: 400 }))).toBeUndefined();
    expect(refusalHint({ kind: "failed" })).toBeUndefined();
  });
});
