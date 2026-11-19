import {
  WRITE_OFF_NOTE_MAX,
  canWriteOff,
  classifyWriteOff,
  isQuarantineStateFilter,
  keepsKey,
  quarantineStateView,
  reasonKindKey,
  writeOffNoteProblem,
} from "@/sale-quarantine/quarantineLogic";
import { describe, expect, test } from "vitest";
import { REQUEST_ID, failure, quarantined } from "./sale-quarantine-fixtures";

describe("quarantine state (the server's, never guessed)", () => {
  test.each([
    ["open", "saleQuarantine.state.open", "badge--warning"],
    ["captured", "saleQuarantine.state.captured", ""],
    ["already-captured", "saleQuarantine.state.alreadyCaptured", ""],
    ["written-off", "saleQuarantine.state.writtenOff", "badge--pending"],
  ])("%s has its own label", (code, labelKey, badge) => {
    const view = quarantineStateView(code);
    expect(view.labelKey).toBe(labelKey);
    expect(view.badge).toBe(badge);
  });

  test("an unknown state is unknown and red, never open", () => {
    const view = quarantineStateView("held-for-review");
    expect(view.labelKey).toBe("saleQuarantine.state.unknown");
    expect(view.badge).toBe("badge--danger");
  });

  test("a name that is only inherited is unknown", () => {
    expect(quarantineStateView("constructor").labelKey).toBe("saleQuarantine.state.unknown");
  });

  test("only an open item can be written off", () => {
    expect(canWriteOff(quarantined({ state: "open" }))).toBe(true);
    for (const state of ["captured", "already-captured", "written-off"] as const) {
      expect(canWriteOff(quarantined({ state }))).toBe(false);
    }
    expect(canWriteOff({ ...quarantined(), state: "something-new" as never })).toBe(false);
  });
});

describe("the state filter", () => {
  test("empty (the open queue) and the four contract states are valid", () => {
    for (const value of ["", "open", "captured", "already-captured", "written-off"]) {
      expect(isQuarantineStateFilter(value)).toBe(true);
    }
  });

  test("anything else is never sent", () => {
    for (const value of ["OPEN", "all", "pending", "open ", "toString"]) {
      expect(isQuarantineStateFilter(value)).toBe(false);
    }
  });
});

describe("reason kind (the till's claim)", () => {
  test.each([
    ["refused", "saleQuarantine.reason.refused"],
    ["payload_divergence", "saleQuarantine.reason.payloadDivergence"],
    ["cashier_claim_refused", "saleQuarantine.reason.cashierClaimRefused"],
    ["held_previous_pairing", "saleQuarantine.reason.heldPreviousPairing"],
    ["something_new", "saleQuarantine.reason.unknown"],
  ])("%s", (code, key) => {
    expect(reasonKindKey(code)).toBe(key);
  });
});

describe("the write-off note", () => {
  test("blank or whitespace-only is required", () => {
    expect(writeOffNoteProblem("")).toBe("saleQuarantine.writeOff.note.required");
    expect(writeOffNoteProblem("   \n\t ")).toBe("saleQuarantine.writeOff.note.required");
  });

  test("500 characters after trim is the limit", () => {
    expect(writeOffNoteProblem("a".repeat(WRITE_OFF_NOTE_MAX))).toBeNull();
    expect(writeOffNoteProblem(`  ${"a".repeat(WRITE_OFF_NOTE_MAX)}  `)).toBeNull();
    expect(writeOffNoteProblem("a".repeat(WRITE_OFF_NOTE_MAX + 1))).toBe(
      "saleQuarantine.writeOff.note.tooLong",
    );
  });

  test("a note with content is valid", () => {
    expect(writeOffNoteProblem("Refunded in cash outside Retail Tower")).toBeNull();
  });
});

describe("classifyWriteOff", () => {
  const written = quarantined({
    state: "written-off",
    writeOff: { at: "2026-11-19T11:00:00Z", note: "Refunded in cash" },
  });

  test("a 200 with the item is written off", () => {
    expect(classifyWriteOff({ status: 200, data: written })).toEqual({
      kind: "written-off",
      item: written,
    });
  });

  test("a 200 without a body is unconfirmed, never a success", () => {
    expect(classifyWriteOff({ status: 200 }).kind).toBe("unconfirmed");
  });

  test("a 409 repair_conflict means the item is no longer open", () => {
    const out = classifyWriteOff(failure(409, "repair_conflict"));
    expect(out).toMatchObject({
      kind: "conflict",
      messageKey: "saleQuarantine.writeOff.error.conflict",
      requestId: REQUEST_ID,
    });
  });

  test("a 409 idempotency_key_conflict is its own outcome", () => {
    expect(classifyWriteOff(failure(409, "idempotency_key_conflict")).kind).toBe("key-conflict");
  });

  test.each([
    [400, "rejected"],
    [401, "session"],
    [403, "forbidden"],
    [404, "not-found"],
  ])("a %i is %s and nothing changed", (status, kind) => {
    expect(classifyWriteOff(failure(status)).kind).toBe(kind);
  });

  test("a 403 origin_rejected has its own copy", () => {
    expect(classifyWriteOff(failure(403, "origin_rejected"))).toMatchObject({
      kind: "forbidden",
      messageKey: "saleQuarantine.writeOff.error.originRejected",
    });
  });

  test("a 429 carries the server's wait", () => {
    expect(classifyWriteOff(failure(429, "rate_limited", 30))).toMatchObject({
      kind: "rate-limited",
      messageKey: "saleQuarantine.writeOff.error.rateLimitedFor",
      retryAfter: 30,
    });
    expect(classifyWriteOff(failure(429))).toMatchObject({
      messageKey: "saleQuarantine.writeOff.error.rateLimited",
    });
  });

  test.each([413, 415, 422])(
    "an unlisted definite %i is a refusal that changed nothing",
    (status) => {
      expect(classifyWriteOff(failure(status))).toMatchObject({
        kind: "rejected",
        messageKey: "saleQuarantine.writeOff.error.rejected",
      });
    },
  );

  test.each([408, 425])("a %i says the server did not finish, so it is unconfirmed", (status) => {
    expect(classifyWriteOff(failure(status)).kind).toBe("unconfirmed");
  });

  test.each([500, 502, 0])("a %i or a lost response is unconfirmed, never failed", (status) => {
    expect(classifyWriteOff({ status })).toMatchObject({
      kind: "unconfirmed",
      messageKey: "saleQuarantine.writeOff.error.unconfirmed",
    });
  });

  test("only an unconfirmed or rate-limited attempt keeps its key", () => {
    expect(keepsKey(classifyWriteOff({ status: 503 }))).toBe(true);
    expect(keepsKey(classifyWriteOff(failure(429)))).toBe(true);
    for (const result of [
      { status: 200, data: written },
      failure(409, "repair_conflict"),
      failure(404),
      failure(403),
      failure(400),
    ]) {
      expect(keepsKey(classifyWriteOff(result))).toBe(false);
    }
  });
});
