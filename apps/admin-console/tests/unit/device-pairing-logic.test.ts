import { classifyMutationFailure, noticeKeyFor } from "@/devices/lifecycleFailure";
import {
  EMPTY_ISSUE_DRAFT,
  type IssueDraft,
  buildIssueBody,
  groupPairingCode,
  newIdempotencyKey,
  validateIssueDraft,
} from "@/devices/pairingLogic";
import { describe, expect, test } from "vitest";
import { DEVICE_1, DUBAI_STORE, NEW_YORK_STORE } from "./device-fixtures";

const valid: IssueDraft = {
  ...EMPTY_ISSUE_DRAFT,
  storeId: DUBAI_STORE,
  branchName: "Dubai Mall",
  branchAddress: "Level 1\nDowntown",
  taxRegistrationId: "TRN-100200300",
};

describe("validateIssueDraft (form checks; the server re-validates everything)", () => {
  test("a complete draft has no problems", () => {
    expect(validateIssueDraft(valid)).toEqual({});
  });

  test("the three binding fields and the store are required (decision C1)", () => {
    const problems = validateIssueDraft(EMPTY_ISSUE_DRAFT);
    expect(Object.keys(problems).sort()).toEqual([
      "branchAddress",
      "branchName",
      "storeId",
      "taxRegistrationId",
    ]);
    expect(problems.branchName?.key).toBe("devices.text.required");
  });

  test("blank is not a value", () => {
    expect(validateIssueDraft({ ...valid, branchName: "   " }).branchName?.key).toBe(
      "devices.text.required",
    );
  });

  test("a draft has no printer field and the checks know none (RT-1165)", () => {
    expect(Object.keys(EMPTY_ISSUE_DRAFT).sort()).toEqual([
      "branchAddress",
      "branchName",
      "storeId",
      "taxRegistrationId",
      "terminalLabel",
    ]);
    expect(Object.keys(validateIssueDraft(EMPTY_ISSUE_DRAFT)).some((k) => /printer/i.test(k))).toBe(
      false,
    );
  });

  test("optional fields may be empty; their limits still hold", () => {
    expect(validateIssueDraft({ ...valid, terminalLabel: "" })).toEqual({});
    expect(validateIssueDraft({ ...valid, terminalLabel: "x".repeat(65) }).terminalLabel).toEqual({
      key: "devices.issue.problem.tooLong",
      params: { max: 64 },
    });
    expect(
      validateIssueDraft({ ...valid, branchName: "x".repeat(257) }).branchName?.params,
    ).toEqual({ max: 256 });
    expect(
      validateIssueDraft({ ...valid, branchAddress: "x".repeat(513) }).branchAddress?.params,
    ).toEqual({ max: 512 });
    expect(
      validateIssueDraft({ ...valid, taxRegistrationId: "x".repeat(65) }).taxRegistrationId?.params,
    ).toEqual({ max: 64 });
  });

  test("a NUL character is refused", () => {
    expect(validateIssueDraft({ ...valid, branchName: "a\u0000b" }).branchName?.key).toBe(
      "devices.text.invalid",
    );
  });

  test("there is no ttl field: the server default applies (RT-1316)", () => {
    expect(EMPTY_ISSUE_DRAFT).not.toHaveProperty("ttlMinutes");
    expect(buildIssueBody(valid)).not.toHaveProperty("ttlMinutes");
  });
});

describe("buildIssueBody", () => {
  test("a plain pairing sends the store and the binding, nothing optional", () => {
    expect(buildIssueBody(valid)).toEqual({
      storeId: DUBAI_STORE,
      branchName: "Dubai Mall",
      branchAddress: "Level 1\nDowntown",
      taxRegistrationId: "TRN-100200300",
    });
    expect(Object.keys(buildIssueBody(valid)).some((k) => /printer/i.test(k))).toBe(false);
  });

  test("replace and move send replacesDeviceId; the server derives the kind from the stores", () => {
    const body = buildIssueBody({ ...valid, storeId: NEW_YORK_STORE }, DEVICE_1);
    expect(body.replacesDeviceId).toBe(DEVICE_1);
    expect(body.storeId).toBe(NEW_YORK_STORE);
    expect(body).not.toHaveProperty("kind");
  });

  test("the optional label is trimmed and sent only when given", () => {
    const body = buildIssueBody({ ...valid, terminalLabel: " Counter 2 " });
    expect(body.terminalLabel).toBe("Counter 2");
  });
});

describe("groupPairingCode (display only; the code itself stays opaque)", () => {
  test("a 16-character code reads in four groups of four", () => {
    expect(groupPairingCode("ABCD2345EFGH6789")).toBe("ABCD-2345-EFGH-6789");
  });

  test("any length groups in fours from the start, with no validation", () => {
    expect(groupPairingCode("")).toBe("");
    expect(groupPairingCode("ABC")).toBe("ABC");
    expect(groupPairingCode("ABCD")).toBe("ABCD");
    expect(groupPairingCode("ABCDE")).toBe("ABCD-E");
    expect(groupPairingCode("abcd1234x")).toBe("abcd-1234-x");
  });
});

describe("idempotency key", () => {
  test("a fresh key per call, within the contract's 16..128 printable range", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\x21-\x7E]{16,128}$/);
  });
});

describe("issue and cancel refusals", () => {
  const body = (code: string) => ({ error: { code, message: "m", request_id: "req-1" } });

  test("a 425 is in progress: never retried with the same key", () => {
    expect(
      classifyMutationFailure({
        status: 425,
        error: { error: "idempotency_in_progress", retryAfterSec: 3 },
      }),
    ).toEqual({ kind: "in-progress", retryAfterSec: 3 });
  });

  test.each([
    ["replacement_already_pending", "devices.issue.error.alreadyPending"],
    ["device_already_replaced", "devices.issue.error.alreadyReplaced"],
    ["idempotency_key_conflict", "devices.issue.error.keyConflict"],
    ["pairing_code_used", "devices.codes.error.used"],
  ])("409 %s has its own message and no preview", (code, key) => {
    const failure = classifyMutationFailure({ status: 409, error: body(code) });
    expect(failure).toMatchObject({ kind: "conflict", code });
    expect(noticeKeyFor(failure)).toBe(key);
  });

  test("409 unresolved_cash_session and device_retired are previewed conflicts", () => {
    for (const code of ["unresolved_cash_session", "device_retired"]) {
      const failure = classifyMutationFailure({ status: 409, error: body(code) });
      expect(noticeKeyFor(failure)).toBe("devices.flow.error.changed");
    }
  });
});
