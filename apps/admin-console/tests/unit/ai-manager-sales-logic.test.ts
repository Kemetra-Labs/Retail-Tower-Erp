import { MANAGER_SALES_ROLES, managerSalesRoleOf } from "@/ai-manager-sales/managerSalesAccess";
import {
  type AskControls,
  TEMPLATE_CHIPS,
  UNAVAILABLE_CODES,
  buildExplainRequest,
  cellKind,
  citationNumbers,
  classifyExplain,
  earliestAsOf,
  figuresByRef,
  orderedNotices,
  plainName,
  unavailableView,
  validateAsk,
} from "@/ai-manager-sales/managerSalesLogic";
import { describe, expect, test } from "vitest";
import {
  REQUEST_ID,
  STORES,
  STORE_A,
  STORE_B,
  answerBody,
  apiError,
  refusalBody,
  unavailableBody,
} from "./ai-manager-sales-fixtures";

const CONTROLS: AskControls = {
  allStores: true,
  pickedStoreIds: [],
  from: "2026-11-01",
  to: "2026-11-07",
  currency: "EGP",
  locale: "ar",
};

describe("access: flag-independent role gate (the flag is read at the mount)", () => {
  test.each(MANAGER_SALES_ROLES)("%s is allowed", (role) => {
    expect(managerSalesRoleOf({ active_tenant: { id: "t" }, active_role_code: role })).toBe(role);
  });

  test.each(["store_staff", "cashier", "", null, undefined])("role %s is not", (role) => {
    expect(managerSalesRoleOf({ active_tenant: { id: "t" }, active_role_code: role })).toBeNull();
  });

  test("a platform admin is hidden, whatever the membership role (the Console treats one as owner elsewhere)", () => {
    expect(
      managerSalesRoleOf({
        user: { is_platform_admin: true },
        active_tenant: { id: "t" },
        active_role_code: "owner",
      }),
    ).toBeNull();
    expect(
      managerSalesRoleOf({ user: { is_platform_admin: true }, active_role_code: "owner" }),
    ).toBeNull();
    expect(managerSalesRoleOf(null)).toBeNull();
  });
});

describe("validateAsk: the contract's rules before anything is sent", () => {
  const chip = { kind: "template", templateId: "T-01" } as const;

  test("a valid ask has no errors", () => {
    expect(validateAsk(CONTROLS, chip, STORES)).toEqual({});
  });

  test("a range of 32 days is refused client-side; 31 days is fine", () => {
    expect(
      validateAsk({ ...CONTROLS, from: "2026-10-01", to: "2026-11-01" }, chip, STORES).to,
    ).toBe("sales.filter.spanTooWide");
    expect(
      validateAsk({ ...CONTROLS, from: "2026-10-01", to: "2026-10-31" }, chip, STORES),
    ).toEqual({});
  });

  test("a reversed range and a bad date are refused", () => {
    expect(
      validateAsk({ ...CONTROLS, from: "2026-11-08", to: "2026-11-07" }, chip, STORES).to,
    ).toBe("sales.filter.rangeReversed");
    expect(validateAsk({ ...CONTROLS, from: "", to: "" }, chip, STORES).from).toBe(
      "sales.filter.dateInvalid",
    );
  });

  test("currency must be a three-letter code; no store picked is refused; no choice is refused", () => {
    expect(validateAsk({ ...CONTROLS, currency: "EG" }, chip, STORES).currency).toBeDefined();
    expect(validateAsk({ ...CONTROLS, allStores: false }, chip, STORES).stores).toBeDefined();
    expect(validateAsk(CONTROLS, null, STORES).choice).toBeDefined();
    expect(
      validateAsk(CONTROLS, { kind: "question", question: "   " }, STORES).choice,
    ).toBeDefined();
    expect(
      validateAsk(CONTROLS, { kind: "question", question: "x".repeat(501) }, STORES).choice,
    ).toBe("aiManagerSales.error.questionTooLong");
  });
});

describe("buildExplainRequest: scope from controls only", () => {
  test("T-01 over all stores, tenant-wide: the empty list, no compare, locale and currency from controls", () => {
    const body = buildExplainRequest(
      CONTROLS,
      { kind: "template", templateId: "T-01" },
      true,
      STORES,
    );
    expect(body).toEqual({
      storeIds: [],
      from: "2026-11-01",
      to: "2026-11-07",
      currency: "EGP",
      locale: "ar",
      templateId: "T-01",
    });
  });

  test("a specific-scope store_manager always sends explicit ids, never the empty list (X-3)", () => {
    const body = buildExplainRequest(
      CONTROLS,
      { kind: "template", templateId: "T-04" },
      false,
      STORES,
    );
    expect(body.storeIds).toEqual([STORE_A, STORE_B]);
  });

  test("picked stores are sent as picked", () => {
    const body = buildExplainRequest(
      { ...CONTROLS, allStores: false, pickedStoreIds: [STORE_B] },
      { kind: "template", templateId: "T-05" },
      true,
      STORES,
    );
    expect(body.storeIds).toEqual([STORE_B]);
  });

  test("the comparison templates send compare=previous_period; the others none", () => {
    const compare = (id: (typeof TEMPLATE_CHIPS)[number]["id"]) =>
      buildExplainRequest(CONTROLS, { kind: "template", templateId: id }, true, STORES).compare;
    expect(compare("T-06")).toBe("previous_period");
    expect(compare("T-07")).toBe("previous_period");
    expect(compare("T-02")).toBeUndefined();
  });

  test("a question is trimmed, selects nothing else, and carries no template and no tenant", () => {
    const body = buildExplainRequest(
      CONTROLS,
      { kind: "question", question: "  how much did Maadi sell last week?  " },
      true,
      STORES,
    );
    expect(body.question).toBe("how much did Maadi sell last week?");
    expect(body.templateId).toBeUndefined();
    expect(body.storeIds).toEqual([]);
    expect(Object.keys(body)).not.toContain("tenant_id");
  });

  test("the chips are exactly T-01..T-10 and T-12", () => {
    expect(TEMPLATE_CHIPS.map((c) => c.id)).toEqual([
      "T-01",
      "T-02",
      "T-03",
      "T-04",
      "T-05",
      "T-06",
      "T-07",
      "T-08",
      "T-09",
      "T-10",
      "T-12",
    ]);
  });
});

describe("classifyExplain: one state per response", () => {
  const sent = buildExplainRequest(
    CONTROLS,
    { kind: "template", templateId: "T-01" },
    true,
    STORES,
  );

  test("200 answer, refusal and unavailable", () => {
    expect(classifyExplain({ status: 200, data: answerBody() }, sent).kind).toBe("answer");
    expect(
      classifyExplain({ status: 200, data: refusalBody("forecast_not_supported") }, sent),
    ).toEqual({
      kind: "refusal",
      code: "forecast_not_supported",
    });
    expect(classifyExplain({ status: 200, data: unavailableBody("not_entitled") }, sent)).toEqual({
      kind: "unavailable",
      code: "not_entitled",
    });
  });

  test.each([
    ["not an object", "nope"],
    ["unknown kind", { kind: "other" }],
    ["unknown refusal code", { kind: "refusal", family: "answer", code: "made_up" }],
    [
      "store_out_of_scope is not an unavailable code (it is the 404)",
      unavailableBody("store_out_of_scope" as never),
    ],
    ["an answer without its arrays", { kind: "answer", scope: {}, period: {} }],
  ])("a 200 body that is %s is a load failure, never a guess", (_name, data) => {
    expect(classifyExplain({ status: 200, data }, sent)).toEqual({ kind: "error" });
  });

  test("400 scope_too_large, a range problem, and any other 400", () => {
    expect(classifyExplain({ status: 400, error: apiError("scope_too_large") }, sent)).toEqual({
      kind: "clarify",
      reason: "scope-too-large",
      requestId: REQUEST_ID,
    });
    const wide = { ...sent, from: "2026-01-01", to: "2026-11-07" };
    expect(
      classifyExplain({ status: 400, error: apiError("validation_error") }, wide),
    ).toMatchObject({
      kind: "clarify",
      reason: "range",
    });
    expect(
      classifyExplain({ status: 400, error: apiError("validation_error") }, sent),
    ).toMatchObject({
      kind: "clarify",
      reason: "invalid",
    });
  });

  test("401, 404 (non-disclosing, no id), 429", () => {
    expect(classifyExplain({ status: 401 }, sent)).toEqual({ kind: "session" });
    expect(classifyExplain({ status: 404, error: apiError("not_found") }, sent)).toEqual({
      kind: "denied",
    });
    expect(classifyExplain({ status: 429 }, sent)).toEqual({ kind: "rate-limited" });
  });

  test.each([403, 409, 425, 500, 503])(
    "%s is a retryable error that keeps the reference",
    (status) => {
      expect(classifyExplain({ status, error: apiError("x") }, sent)).toEqual({
        kind: "error",
        requestId: REQUEST_ID,
      });
    },
  );
});

describe("unavailableView: copy by code and role (D-6)", () => {
  test("every contract code has a view", () => {
    for (const code of UNAVAILABLE_CODES) {
      expect(unavailableView(code, "owner").messageKey).toMatch(/^aiManagerSales\./);
    }
  });

  test("the kill switch is the same for everyone", () => {
    expect(unavailableView("feature_disabled_system", "store_manager").messageKey).toBe(
      "aiManagerSales.unavailable.system",
    );
  });

  test("only the owner is told about the opt-out and the question limit", () => {
    expect(unavailableView("feature_disabled_tenant", "owner").messageKey).toBe(
      "aiManagerSales.unavailable.optOutOwner",
    );
    expect(unavailableView("quota_exhausted", "owner").messageKey).toBe(
      "aiManagerSales.unavailable.quotaOwner",
    );
    for (const role of ["tenant_admin", "store_manager"]) {
      expect(unavailableView("feature_disabled_tenant", role).messageKey).toBe(
        "aiManagerSales.unavailable.generic",
      );
      expect(unavailableView("quota_exhausted", role).messageKey).toBe(
        "aiManagerSales.unavailable.generic",
      );
    }
  });

  test("spend and credit state is never named; evidence and ledger failures are retryable errors", () => {
    for (const code of ["spend_cap_reached", "free_credit_exhausted"] as const) {
      expect(unavailableView(code, "owner").tone).toBe("info");
      expect(unavailableView(code, "store_manager").messageKey).toBe(
        "aiManagerSales.unavailable.generic",
      );
    }
    expect(unavailableView("evidence_unavailable", "owner")).toMatchObject({
      tone: "error",
      retry: true,
    });
    expect(unavailableView("entitlement_unavailable", "owner")).toMatchObject({
      tone: "error",
      retry: true,
    });
  });
});

describe("answer helpers: select and index, never compute", () => {
  test("plainName strips bidi controls and nothing else", () => {
    expect(plainName("‮Maadi⁦ <b>x</b>‏")).toBe("Maadi <b>x</b>");
  });

  test("the earlier asOf is the one shown; two are never merged", () => {
    const sources = [
      { ...answerBody().sources[0], asOf: "2026-11-07T14:30:00Z" },
      {
        ...answerBody().sources[0],
        operationId: "consoleGetSalesSummary" as const,
        asOf: "2026-11-07T14:29:00Z",
      },
    ];
    expect(earliestAsOf(sources)).toBe("2026-11-07T14:29:00Z");
    expect(earliestAsOf([])).toBeUndefined();
  });

  test("cell kinds follow the value as received", () => {
    const cell = (value: string | number, currency?: string) => ({ ref: "r", value, currency });
    expect(cellKind(cell(12))).toBe("count");
    expect(cellKind(cell("1250.5000", "EGP"))).toBe("money");
    expect(cellKind(cell("0.6250"))).toBe("ratio");
    expect(cellKind(cell("2026-11-07"))).toBe("date");
    expect(cellKind(cell("Maadi"))).toBe("text");
  });

  test("citations number by ref in server order; figures index by ref", () => {
    const answer = answerBody();
    const numbers = citationNumbers(answer.citations);
    expect(numbers.get(answer.citations[0].ref)).toBe(1);
    expect(numbers.get(answer.citations[7].ref)).toBe(8);
    expect(figuresByRef(answer.blocks).size).toBe(8);
  });

  test("notices come out in a fixed reading order", () => {
    expect(orderedNotices(["multi_currency", "received_only", "day_in_progress"])).toEqual([
      "received_only",
      "day_in_progress",
      "multi_currency",
    ]);
  });
});
