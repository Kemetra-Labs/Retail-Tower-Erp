/**
 * RT-1539 — the deterministic matcher `msx-match/1`: closed lexicon, refusal wins, fixed template
 * priority, controls-only parameters. The 38 hand-written P-07 cases (`msx-eval/1`, read only) drive
 * every question that reaches the match step; extra cases pin each refusal code and the edge rules.
 */
import { MSX_CASES } from "../eval/manager-sales/msx.cases";
import { matchRequest, normalizeText, type MatchInput } from "../../../src/ai/manager-sales/msx.matcher";
import { MSX_MATCH_VERSION } from "../../../src/ai/manager-sales/msx.constants";

function inputOf(request: Readonly<Record<string, unknown>>): MatchInput {
  const from = request["from"] as string;
  const to = request["to"] as string;
  return {
    ...(request["templateId"] === undefined ? {} : { templateId: request["templateId"] as NonNullable<MatchInput["templateId"]> }),
    ...(request["question"] === undefined ? {} : { question: request["question"] as string }),
    storeCount: (request["storeIds"] as string[]).length,
    from,
    to,
  };
}

const base = { storeCount: 0, from: "2026-11-08", to: "2026-11-14" };

describe("msx-match/1", () => {
  it("is versioned", () => {
    expect(MSX_MATCH_VERSION).toBe("msx-match/1");
  });

  describe("the P-07 dataset questions", () => {
    const withQuestion = MSX_CASES.filter(
      (c) => typeof c.request["question"] === "string" && (c.expected.status === 200),
    ).filter((c) => !c.preconditions.some((p) => p === "kill_switch_off" || p === "tenant_owner_opted_out"));

    it("covers the answer and refusal cases", () => {
      expect(withQuestion.length).toBeGreaterThanOrEqual(25);
    });

    it.each(withQuestion.map((c) => [c.id, c] as const))("%s", (_id, c) => {
      const outcome = matchRequest(inputOf(c.request));
      const expected = c.expected;
      if (expected.status !== 200) throw new Error("filtered out");
      if (expected.kind === "refusal") {
        expect(outcome).toEqual({ kind: "refusal", code: expected.code });
      } else if (expected.kind === "answer") {
        expect(outcome).toMatchObject({ kind: "template", templateId: expected.body.templateId });
        if (outcome.kind === "template") {
          expect(outcome.declined).toEqual(expected.body.declined);
          expect(outcome.parametersFromControlsOnly).toBe(expected.body.notices.includes("parameters_from_controls_only"));
        }
      }
    });
  });

  describe("every refusal code", () => {
    it.each([
      ["finance_source_absent", "what is our profit"],
      ["finance_source_absent", "show gross margin"],
      ["finance_source_absent", "cost of goods sold"],
      ["finance_source_absent", "net sales please"],
      ["finance_source_absent", "كم الربح هذا الشهر"],
      ["finance_source_absent", "هامش الربح"],
      ["forecast_not_supported", "forecast next month"],
      ["forecast_not_supported", "predict tomorrow's sales"],
      ["forecast_not_supported", "توقع لي المبيعات"],
      ["write_action_not_supported", "refund the last sale"],
      ["write_action_not_supported", "change the price of milk"],
      ["write_action_not_supported", "delete this store"],
      ["write_action_not_supported", "احذف آخر فاتورة"],
      ["unsupported_question", "tell me a joke"],
      ["unsupported_question", "   "],
      ["unsupported_question", "؟؟؟"],
    ])("%s: %s", (code, question) => {
      expect(matchRequest({ ...base, question })).toEqual({ kind: "refusal", code });
    });

    it("a refusal term wins over a template term (M-4), even with a chip", () => {
      expect(matchRequest({ ...base, question: "total sales and profit" })).toEqual({ kind: "refusal", code: "finance_source_absent" });
      expect(matchRequest({ ...base, templateId: "T-01", question: "forecast total sales" })).toEqual({ kind: "refusal", code: "forecast_not_supported" });
    });

    it("finance beats forecast beats write when several appear", () => {
      expect(matchRequest({ ...base, question: "forecast profit" })).toEqual({ kind: "refusal", code: "finance_source_absent" });
      expect(matchRequest({ ...base, question: "forecast and refund" })).toEqual({ kind: "refusal", code: "forecast_not_supported" });
    });

    it("the nouns voids, returns and refunds are a question (T-03), not a write", () => {
      expect(matchRequest({ ...base, question: "How many returns and refunds?" })).toMatchObject({ kind: "template", templateId: "T-03" });
      expect(matchRequest({ ...base, question: "كم المرتجعات" })).toMatchObject({ kind: "template", templateId: "T-03" });
    });
  });

  describe("chips (M-1)", () => {
    it.each(["T-01", "T-02", "T-03", "T-04", "T-05", "T-06", "T-07", "T-08", "T-09", "T-10", "T-12"] as const)("%s without a question matches itself", (templateId) => {
      expect(matchRequest({ ...base, templateId })).toMatchObject({ kind: "template", templateId, parametersFromControlsOnly: false });
    });

    it("the chip wins over the question's template", () => {
      expect(matchRequest({ ...base, templateId: "T-02", question: "rank my stores" })).toMatchObject({ templateId: "T-02" });
    });

    it("T-07 always declines the cause; T-10 declines only a conclusive claim", () => {
      expect(matchRequest({ ...base, templateId: "T-07" })).toMatchObject({ declined: ["causal_not_supported"] });
      expect(matchRequest({ ...base, templateId: "T-10" })).toMatchObject({ declined: [] });
      expect(matchRequest({ ...base, templateId: "T-10", question: "is this the final number" })).toMatchObject({ declined: ["partial_data_not_conclusive"] });
      expect(matchRequest({ ...base, question: "why is this not final" })).toMatchObject({ templateId: "T-10", declined: [] });
    });
  });

  describe("free text", () => {
    it("breaks ties by the fixed priority T-10 > T-07 > T-06 > T-05 > T-12 > T-04 > T-08 > T-09 > T-03 > T-02 > T-01", () => {
      expect(matchRequest({ ...base, question: "why is the total partial" })).toMatchObject({ templateId: "T-10" });
      expect(matchRequest({ ...base, question: "why are sales down versus last week" })).toMatchObject({ templateId: "T-07" });
      expect(matchRequest({ ...base, question: "total sales versus last period" })).toMatchObject({ templateId: "T-06" });
      expect(matchRequest({ ...base, storeCount: 2, question: "compare the best day" })).toMatchObject({ templateId: "T-05" });
      expect(matchRequest({ ...base, question: "which stores had no sales, rank them" })).toMatchObject({ templateId: "T-12" });
      expect(matchRequest({ ...base, question: "rank by best day" })).toMatchObject({ templateId: "T-04" });
      expect(matchRequest({ ...base, question: "best day average sale" })).toMatchObject({ templateId: "T-08" });
      expect(matchRequest({ ...base, question: "average sale and voids" })).toMatchObject({ templateId: "T-09" });
      expect(matchRequest({ ...base, question: "voids and total sales day by day" })).toMatchObject({ templateId: "T-03" });
      expect(matchRequest({ ...base, question: "total sales day by day" })).toMatchObject({ templateId: "T-02" });
      expect(matchRequest({ ...base, question: "total sales" })).toMatchObject({ templateId: "T-01" });
    });

    it("the same input always gives the same outcome", () => {
      const a = matchRequest({ ...base, question: "Rank my stores" });
      expect(matchRequest({ ...base, question: "Rank my stores" })).toEqual(a);
    });

    it("compare with fewer than two selected stores is the ranking T-04; with two or more it is T-05", () => {
      expect(matchRequest({ ...base, storeCount: 0, question: "compare my stores" })).toMatchObject({ templateId: "T-04" });
      expect(matchRequest({ ...base, storeCount: 1, question: "compare my stores" })).toMatchObject({ templateId: "T-04" });
      expect(matchRequest({ ...base, storeCount: 2, question: "compare my stores" })).toMatchObject({ templateId: "T-05" });
    });

    it("ignores case, Arabic diacritics, tatweel, alef variants and bidi controls", () => {
      expect(matchRequest({ ...base, question: "RANK  My   Stores" })).toMatchObject({ templateId: "T-04" });
      const diacritics = [0x0631, 0x064e, 0x062a, 0x0650, 0x0651, 0x0628].map((c) => String.fromCodePoint(c)).join("");
      expect(matchRequest({ ...base, question: `${diacritics} متاجري` })).toMatchObject({ templateId: "T-04" });
      expect(matchRequest({ ...base, question: `${String.fromCodePoint(0x202e)}rank${String.fromCodePoint(0x2066)} stores` })).toMatchObject({ templateId: "T-04" });
      expect(matchRequest({ ...base, question: "إجمالي المبيعات" })).toMatchObject({ templateId: "T-01" });
    });

    it("never resolves or echoes a name in the text: the outcome carries no question text", () => {
      const outcome = matchRequest({ ...base, question: "total sales of Zamalek Branch B1 SECRET-TEXT" });
      expect(JSON.stringify(outcome)).not.toContain("SECRET-TEXT");
      expect(JSON.stringify(outcome)).not.toContain("Zamalek");
    });
  });

  describe("parameters come from the controls (M-6)", () => {
    const week = { storeCount: 0, from: "2026-11-08", to: "2026-11-14" };
    const day = { storeCount: 0, from: "2026-11-18", to: "2026-11-18" };
    it.each([
      ["today with a one-day control", day, "total sales today", false],
      ["today with a week control", week, "total sales today", true],
      ["yesterday with a week control", week, "total sales yesterday", true],
      ["this week with a week control", week, "total sales this week", false],
      ["this week with a one-day control", day, "total sales this week", true],
      ["this month with a 31-day control", { storeCount: 0, from: "2026-10-01", to: "2026-10-31" }, "total sales this month", false],
      ["this month with a week control", week, "total sales this month", true],
      ["an ISO date the controls do not hold", week, "total sales on 2026-11-02", true],
      ["an ISO date inside the controls", week, "total sales on 2026-11-09", false],
      ["a day count matching the controls", week, "total sales last 7 days", false],
      ["a day count not matching the controls", week, "total sales last 30 days", true],
      ["Arabic-Indic digits", week, "إجمالي المبيعات آخر ٣٠ يوم", true],
      ["no period word", week, "total sales", false],
    ])("%s", (_name, controls, question, expected) => {
      expect(matchRequest({ ...controls, question })).toMatchObject({ kind: "template", parametersFromControlsOnly: expected });
    });
  });

  describe("normalizeText", () => {
    it("lower-cases, strips marks and bidi controls, folds alef/ya/ta marbuta and collapses whitespace", () => {
      const raw = `  Ab${String.fromCodePoint(0x202e)}C ${String.fromCodePoint(0x064b)}${String.fromCodePoint(0x0623, 0x0625, 0x0622)} ${String.fromCodePoint(0x0649)} ${String.fromCodePoint(0x0629)}  `;
      expect(normalizeText(raw)).toBe(`abc ${String.fromCodePoint(0x0627).repeat(3)} ${String.fromCodePoint(0x064a)} ${String.fromCodePoint(0x0647)}`);
    });
  });
});
