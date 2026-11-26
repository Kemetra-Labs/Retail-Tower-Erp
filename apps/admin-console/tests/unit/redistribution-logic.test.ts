import {
  acceptableLineIds,
  canReadRedistribution,
  canUseRedistribution,
  createdTransferIds,
  dedupeById,
  dropReasonKey,
  exclusionKey,
  isDecidable,
  lineActions,
  stateBadgeClass,
  stateKey,
  warningKey,
} from "@/redistribution/redistributionLogic";
import { UNCERTAIN, classifyRedistributionResult } from "@/redistribution/redistributionOutcomes";
import { describe, expect, test } from "vitest";
import {
  LINE_1,
  LINE_2,
  TRANSFER_1,
  createdOutcome,
  droppedOutcome,
  line,
  proposal,
} from "./redistribution-fixtures";

/** RT-1601: access, state gating, open-string codes and the command outcome classifier. */

describe("access", () => {
  test("owner and tenant_admin only, and only with every store in scope", () => {
    expect(canReadRedistribution("owner")).toBe(true);
    expect(canReadRedistribution("tenant_admin")).toBe(true);
    for (const role of ["store_manager", "store_staff", null, undefined]) {
      expect(canReadRedistribution(role)).toBe(false);
    }
    expect(canUseRedistribution("owner", "all")).toBe(true);
    expect(canUseRedistribution("owner", undefined)).toBe(true);
    expect(canUseRedistribution("tenant_admin", "specific")).toBe(false);
    expect(canUseRedistribution("store_manager", "all")).toBe(false);
  });
});

describe("states", () => {
  test("every contract state has a label; an unknown one reads generically", () => {
    expect(stateKey("partially_accepted")).toBe("redistribution.state.partially_accepted");
    expect(stateKey("archived")).toBe("redistribution.state.unknown");
    expect(stateBadgeClass("open")).toContain("warning");
    expect(stateBadgeClass("accepted")).toContain("success");
    expect(stateBadgeClass("rejected")).toBe("badge");
    expect(stateBadgeClass("archived")).toContain("danger");
  });

  test("only open, reviewed and partially_accepted take decisions", () => {
    expect(["open", "reviewed", "partially_accepted"].every(isDecidable)).toBe(true);
    expect(["accepted", "rejected", "expired", "superseded"].some(isDecidable)).toBe(false);
  });
});

describe("lines", () => {
  test("shadow: review only, never accept", () => {
    expect(lineActions(proposal(), line())).toEqual({ review: true, accept: false });
  });

  test("live: an undecided line can be reviewed and accepted", () => {
    expect(lineActions(proposal({ acceptEnabled: true }), line())).toEqual({
      review: true,
      accept: true,
    });
  });

  test("a line with an outcome, or a terminal proposal, takes nothing", () => {
    const live = proposal({ acceptEnabled: true });
    expect(lineActions(live, line({ acceptOutcome: createdOutcome }))).toEqual({
      review: false,
      accept: false,
    });
    expect(lineActions({ ...live, state: "expired" }, line())).toEqual({
      review: false,
      accept: false,
    });
  });

  test("acceptable ids skip decided lines; transfers are listed once each", () => {
    const p = proposal({
      acceptEnabled: true,
      state: "partially_accepted",
      lines: [
        line({ acceptOutcome: createdOutcome }),
        line({ id: LINE_2 }),
        line({ id: "x", acceptOutcome: { ...createdOutcome } }),
        line({ id: "y", acceptOutcome: droppedOutcome }),
      ],
    });
    expect(acceptableLineIds(p)).toEqual([LINE_2]);
    expect(createdTransferIds(p)).toEqual([TRANSFER_1]);
    expect(acceptableLineIds(proposal())).toEqual([]);
    expect(LINE_1).not.toBe(LINE_2);
  });
});

describe("open-string codes", () => {
  test("known codes map to their label, unknown codes read generically", () => {
    expect(exclusionKey("inactive")).toBe("redistribution.exclusion.inactive");
    expect(exclusionKey("new_reason")).toBe("redistribution.exclusion.unknown");
    expect(warningKey("source_near_reorder_level")).toBe(
      "redistribution.warning.source_near_reorder_level",
    );
    expect(warningKey("constructor")).toBe("redistribution.warning.unknown");
    expect(dropReasonKey("destination_gap_closed")).toBe(
      "redistribution.reason.destination_gap_closed",
    );
    expect(dropReasonKey("x")).toBe("redistribution.reason.unknown");
  });

  test("dedupe keeps the first row of each id", () => {
    expect(dedupeById([{ id: "a" }, { id: "b" }, { id: "a" }])).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("command outcomes", () => {
  const err = (code: string) => ({ error: { code, message: "m", request_id: "req-1" } });

  test("2xx with a body is ok", () => {
    expect(classifyRedistributionResult({ status: 201, data: { id: "p" } })).toEqual({
      kind: "ok",
      data: { id: "p" },
    });
  });

  test("409 codes name the move and ask for a re-read; an unknown 409 is generic", () => {
    for (const [code, key] of [
      ["proposal_superseded", "redistribution.error.superseded"],
      ["proposal_expired", "redistribution.error.expired"],
      ["proposal_state_conflict", "redistribution.error.stateConflict"],
      ["proposal_line_already_decided", "redistribution.error.lineDecided"],
      ["proposal_stale", "redistribution.error.stale"],
    ] as const) {
      expect(classifyRedistributionResult({ status: 409, error: err(code) })).toEqual({
        kind: "failed",
        messageKey: key,
        requestId: "req-1",
        keepKey: false,
        refresh: true,
      });
    }
    const conflict = classifyRedistributionResult({
      status: 409,
      error: err("idempotency_key_conflict"),
    });
    expect(conflict).toMatchObject({ messageKey: "redistribution.error.generic", refresh: false });
  });

  test("422 compute refusals are named; 404 never says why", () => {
    expect(
      classifyRedistributionResult({ status: 422, error: err("redistribution_too_large") }),
    ).toMatchObject({ messageKey: "redistribution.error.tooLarge" });
    expect(
      classifyRedistributionResult({ status: 422, error: err("redistribution_plan_invalid") }),
    ).toMatchObject({ messageKey: "redistribution.error.planInvalid" });
    expect(classifyRedistributionResult({ status: 404, error: err("not_found") })).toMatchObject({
      messageKey: "redistribution.error.notAvailable",
      keepKey: false,
    });
  });

  test("425, 429 and 5xx keep the key; 400, 401, 403 do not", () => {
    for (const status of [425, 429, 500, 503]) {
      expect(classifyRedistributionResult({ status })).toMatchObject({ keepKey: true });
    }
    // 425 and 5xx may have landed: re-read; 429 ran nothing.
    for (const status of [425, 500]) {
      expect(classifyRedistributionResult({ status })).toMatchObject({ refresh: true });
    }
    expect(classifyRedistributionResult({ status: 429 })).toMatchObject({ refresh: false });
    expect(classifyRedistributionResult({ status: 400 })).toMatchObject({
      messageKey: "redistribution.error.validation",
      keepKey: false,
    });
    expect(classifyRedistributionResult({ status: 401 })).toMatchObject({
      messageKey: "redistribution.error.session",
    });
    expect(classifyRedistributionResult({ status: 403 })).toMatchObject({
      messageKey: "redistribution.error.origin",
    });
    expect(classifyRedistributionResult({ status: 418 })).toMatchObject({
      messageKey: "redistribution.error.generic",
    });
    expect(UNCERTAIN).toMatchObject({ keepKey: true, refresh: true });
  });
});
