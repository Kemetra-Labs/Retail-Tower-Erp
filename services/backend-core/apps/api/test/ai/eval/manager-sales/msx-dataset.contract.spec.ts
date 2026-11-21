/**
 * RT-1540 (W8 P-07 part 1) — the pinned `msx-eval/1` dataset contract.
 *
 * Fixtures only: every body is synthetic and is validated here against the real
 * P-05 OpenAPI schemas on `main` (RT-1538). The dataset hash is pinned as a
 * literal: a change to a case, a body or a gold label is a new dataset version,
 * never a silent edit. This spec runs offline: no provider is constructed and
 * nothing opens a socket.
 */
import { datasetHash } from "./msx.canonical";
import { MSX_CASES, caseOf } from "./msx.cases";
import { spanViolation, validateRequest, validateResponse } from "./msx.schema";
import { MSX_GATES, MSX_LANGUAGES, MSX_DATASET_VERSION, type AnswerBody, type MsxCase } from "./msx.types";
import { STORE_A1, STORE_A2, STORE_A3, STORE_B1, TENANT_A, TENANT_B, NAME_B1 } from "./msx.world";

const PINNED_DATASET_SHA256 = "e26e07f6d2d8ecab8a3980635670e1f0c32aa44640995789ddb95daaeafc5309";

/** Metrics that are money: numeric(19,4) text whose table cell carries its currency code. */
const MONEY_METRIC = /(^|\.)total$|baselineTotal$|averageSale$/;
const ARABIC = /[؀-ۿ]/;
const BIDI_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((cp) =>
  String.fromCodePoint(cp),
);
const hasBidi = (text: string): boolean => BIDI_CONTROLS.some((c) => text.includes(c));
const stripBidi = (text: string): string => BIDI_CONTROLS.reduce((acc, c) => acc.split(c).join(""), text);

const answers = MSX_CASES.filter((c) => c.expected.status === 200 && c.expected.kind === "answer");
const bodyOf = (c: MsxCase): unknown => ("body" in c.expected ? c.expected.body : undefined);

describe("msx-eval/1 dataset", () => {
  it("has exactly 38 unique cases, ids case-01..case-38, mapped to RT-1526 v6 section 6 rows 1..38", () => {
    expect(MSX_DATASET_VERSION).toBe("msx-eval/1");
    expect(MSX_CASES).toHaveLength(38);
    expect(MSX_CASES.map((c) => c.id)).toEqual(Array.from({ length: 38 }, (_, i) => `case-${String(i + 1).padStart(2, "0")}`));
    expect(new Set(MSX_CASES.map((c) => c.id)).size).toBe(38);
    expect(MSX_CASES.map((c) => c.section6)).toEqual(Array.from({ length: 38 }, (_, i) => i + 1));
    for (const c of MSX_CASES) expect(c.traceability).toContain(`RT-1526 v6 §6 case ${c.section6}`);
  });

  it("pins the content hash of cases, evidence fixtures and expected outcomes", () => {
    expect(datasetHash()).toBe(PINNED_DATASET_SHA256);
  });

  describe("requests against the P-05 request schema", () => {
    it("accepts every valid request, and rejects every deliberate validation-failure case", () => {
      const wrong = MSX_CASES.flatMap((c) => {
        const verdict = validateRequest(c.request);
        const span = spanViolation(c.request);
        if (c.requestValidity === "valid") return verdict.valid && !span ? [] : [`${c.id} should be valid: ${verdict.errors} span=${span}`];
        if (c.requestValidity === "schema_violation") return verdict.valid ? [`${c.id} must fail the schema`] : [];
        return verdict.valid && span ? [] : [`${c.id} must pass the schema and fail the 31-day span rule`];
      });
      expect(wrong).toEqual([]);
    });

    it("expects 400 validation_error exactly for the deliberate failures (cases 20 and 35)", () => {
      const rejected = MSX_CASES.filter((c) => c.requestValidity !== "valid");
      expect(rejected.map((c) => c.id)).toEqual(["case-20", "case-35"]);
      for (const c of rejected) expect(c.expected).toEqual({ status: 400, code: "validation_error" });
      expect(rejected.map((c) => c.requestValidity)).toEqual(["schema_violation", "span_violation"]);
    });

    it("sends the tenant-leak probe as an unknown key and never carries a tenant on any valid request", () => {
      expect(caseOf("case-20").request).toMatchObject({ tenant_id: TENANT_B });
      for (const c of MSX_CASES.filter((x) => x.requestValidity === "valid")) expect(Object.keys(c.request)).not.toContain("tenant_id");
    });

    it("keeps the request locale aligned with the case language and the question script", () => {
      for (const c of MSX_CASES) {
        expect(c.request["locale"]).toBe(c.language === "en" ? "en" : "ar");
        const question = String(c.request["question"] ?? "");
        if (question !== "") expect(ARABIC.test(question)).toBe(c.language !== "en");
      }
    });

    it("keeps valid requests inside the caller's stores; a specific-scope caller never sends an empty list except in case 19", () => {
      for (const c of MSX_CASES.filter((x) => x.requestValidity === "valid" && x.expected.status !== 404)) {
        const ids = c.request["storeIds"] as string[];
        if (c.caller.storeAccess === "specific") {
          expect(ids.length).toBeGreaterThan(0);
          for (const sid of ids) expect(c.caller.storeIds).toContain(sid);
        }
      }
      expect(caseOf("case-19").request["storeIds"]).toEqual([]);
      expect(caseOf("case-19").caller.storeAccess).toBe("specific");
    });
  });

  describe("expected 200 outcomes against the P-05 response schema", () => {
    it("validates every expected 200 body (answer, refusal, unavailable)", () => {
      const bodies = MSX_CASES.filter((c) => c.expected.status === 200);
      expect(bodies.length).toBeGreaterThan(30);
      const wrong = bodies.flatMap((c) => {
        const verdict = validateResponse(bodyOf(c));
        return verdict.valid ? [] : [`${c.id}: ${verdict.errors}`];
      });
      expect(wrong).toEqual([]);
    });

    it("proves the response validator can fail: a body with an extra key, a store_out_of_scope code, or a stray kind is rejected", () => {
      const first = answers[0];
      if (!first) throw new Error("no answer case");
      expect(validateResponse({ ...(first.expected as { body: object }).body, extra: 1 }).valid).toBe(false);
      expect(validateResponse({ kind: "unavailable", family: "gateway", code: "store_out_of_scope" }).valid).toBe(false);
      expect(validateResponse({ kind: "unavailable", family: "gateway", code: "not_authorized" }).valid).toBe(false);
      expect(validateResponse({ kind: "refusal", family: "answer", code: "causal_not_supported" }).valid).toBe(false);
    });

    it("matches the template id of a chip request, and answers with the contract's fixed versions and tier-0 ledger", () => {
      for (const c of answers) {
        const body = bodyOf(c) as { templateId: string; ledger: { routing_tier: number; routeKey: string } };
        if (c.request["templateId"] !== undefined) expect(body.templateId).toBe(c.request["templateId"]);
        expect(body.ledger).toMatchObject({ routing_tier: 0, routeKey: "deterministic_no_model" });
      }
    });
  });

  describe("negative controls and boundaries", () => {
    const answerBody = (): AnswerBody => {
      const first = answers.find((c) => c.id === "case-02");
      if (first === undefined) throw new Error("case-02 missing");
      return JSON.parse(JSON.stringify(bodyOf(first))) as AnswerBody;
    };
    type Loose = { blocks: { rows?: { extra?: number }[][]; extra?: number }[]; citations: { extra?: number }[]; notices: string[] };

    it("rejects an extra key nested in a block, a cell or a citation, and an unknown notice", () => {
      const mutate = (edit: (b: Loose) => void): boolean => {
        const body = answerBody() as unknown as Loose;
        edit(body);
        return validateResponse(body).valid;
      };
      expect(mutate(() => undefined)).toBe(true);
      expect(mutate((b) => { b.blocks[0]!.extra = 1; })).toBe(false);
      expect(mutate((b) => { b.blocks[0]!.rows![0]![0]!.extra = 1; })).toBe(false);
      expect(mutate((b) => { b.citations[0]!.extra = 1; })).toBe(false);
      expect(mutate((b) => { b.notices.push("bogus_notice"); })).toBe(false);
    });

    it("explains the case 20 rejection: an additional property, tenant_id", () => {
      const verdict = validateRequest(caseOf("case-20").request);
      expect(verdict.valid).toBe(false);
      expect(verdict.errors).toContain("additional properties");
      expect(verdict.errors).toContain("tenant_id");
    });

    it("applies the 31-day rule: 31 days inclusive passes, 32 fails, an inverted range fails", () => {
      expect(spanViolation({ from: "2026-10-01", to: "2026-10-01" })).toBe(false);
      expect(spanViolation({ from: "2026-10-01", to: "2026-10-31" })).toBe(false);
      expect(spanViolation({ from: "2026-10-01", to: "2026-11-01" })).toBe(true);
      expect(spanViolation({ from: "2026-10-02", to: "2026-10-01" })).toBe(true);
    });

    it("case 10 states rankable=false in the pack and answers with a sentence: no table, no rank cell", () => {
      const c = caseOf("case-10");
      expect((c.evidence?.figures ?? []).find((f) => f.metric === "rankable")?.value).toBe(false);
      const body = bodyOf(c) as AnswerBody;
      expect(body.blocks.map((b) => b.type)).toEqual(["statement"]);
      expect(body.citations.map((x) => x.ref).some((ref) => /ranking\.rank$/.test(ref))).toBe(false);
      expect(body.citations.some((x) => x.ref.endsWith(":rankable"))).toBe(true);
    });
  });

  describe("owner decision RT-1538 comment 18048: an out-of-scope or unknown store, and a refused role, is the 404", () => {
    it("encodes cases 18, 19 and 36 as HTTP 404 not_found with their traceability to the decision", () => {
      for (const id of ["case-18", "case-19", "case-36"]) {
        const c = caseOf(id);
        expect(c.expected).toEqual({ status: 404, code: "not_found" });
        expect(c.traceability).toContain("RT-1538 comment 18048");
      }
    });

    it("never expects a 200 store_out_of_scope or not_authorized anywhere", () => {
      const text = JSON.stringify(MSX_CASES.map((c) => c.expected));
      expect(text).not.toContain("store_out_of_scope");
      expect(text).not.toContain("not_authorized");
    });

    it("reads nothing and reserves nothing on every 404", () => {
      for (const c of MSX_CASES.filter((x) => x.expected.status === 404)) {
        expect(c.effects).toMatchObject({ evidenceReads: "none", reservation: "none" });
        expect(c.evidence).toBeNull();
      }
    });
  });

  describe("safety gates G-S1..G-S6", () => {
    it("covers every gate with at least one case, and maps every case to at least one gate", () => {
      for (const gate of MSX_GATES) expect(MSX_CASES.some((c) => c.gates.includes(gate))).toBe(true);
      for (const c of MSX_CASES) {
        expect(c.gates.length).toBeGreaterThan(0);
        for (const gate of c.gates) expect(MSX_GATES).toContain(gate);
      }
    });

    it("G-S4: every case carries exactly one expected outcome with a status", () => {
      for (const c of MSX_CASES) expect([200, 400, 404]).toContain(c.expected.status);
      expect(MSX_CASES.every((c) => c.gates.includes("G-S4"))).toBe(true);
    });

    it("G-S6: tier 0 only, zero provider requests and zero tokens on every case", () => {
      for (const c of MSX_CASES) {
        expect(c.effects.providerRequests).toBe(0);
        expect(c.effects.tokens).toBe(0);
        expect(c.gates).toContain("G-S6");
      }
    });

    it("G-S3: validation, gateway, match and scope paths read nothing and reserve nothing; the evidence failure releases", () => {
      for (const c of MSX_CASES) {
        const e = c.expected;
        const endsEarly = e.status !== 200 || e.kind === "refusal" || (e.kind === "unavailable" && e.code !== "evidence_unavailable");
        if (endsEarly) expect(c.effects).toMatchObject({ evidenceReads: "none", reservation: "none" });
        if (c.gates.includes("G-S3") && c.id !== "case-32") expect(endsEarly).toBe(true);
      }
      expect(caseOf("case-32").effects).toMatchObject({ evidenceReads: "attempted", reservation: "released" });
      expect(caseOf("case-32").preconditions).toContain("summary_read_throws");
      for (const c of answers) expect(c.effects).toMatchObject({ evidenceReads: "completed", reservation: "committed" });
    });

    it("G-S1: no tenant B id or name, and no store outside the caller's scope, in any expected output", () => {
      for (const c of MSX_CASES) {
        const text = JSON.stringify(c.expected);
        const packText = JSON.stringify(c.evidence ?? {});
        for (const forbidden of [TENANT_B, STORE_B1, NAME_B1]) {
          expect(text).not.toContain(forbidden);
          expect(packText).not.toContain(forbidden);
        }
        const body = bodyOf(c) as { scope?: { storeRefs: string[] } } | undefined;
        const allowed = c.caller.storeAccess === "all" ? [STORE_A1, STORE_A2, STORE_A3] : c.caller.storeIds;
        for (const ref of body?.scope?.storeRefs ?? []) expect(allowed).toContain(ref);
        for (const uuid of `${text}${packText}`.match(/0191e540-0000-7000-8000-[0-9a-f]{12}/g) ?? []) expect([...allowed, TENANT_A]).toContain(uuid);
      }
    });

    it("G-S2: every displayed number is a pack field carrying its ref, copied exactly as the read returned it", () => {
      for (const c of answers) {
        const body = bodyOf(c) as AnswerBody;
        const pack = new Map((c.evidence?.figures ?? []).map((f) => [f.ref, f]));
        const cited = new Set(body.citations.map((x) => x.ref));
        for (const block of body.blocks) {
          const refs = block.type === "table" ? block.rows.flat().map((cell) => cell.ref) : Object.values(block.slots).map((s) => s.ref);
          for (const ref of refs) {
            expect(pack.has(ref)).toBe(true);
            expect(cited.has(ref)).toBe(true);
          }
          if (block.type !== "table") continue;
          for (const cell of block.rows.flat()) {
            const figure = pack.get(cell.ref);
            const expectedValue = typeof figure?.value === "string" ? stripBidi(figure.value) : figure?.value;
            expect({ id: c.id, value: cell.value }).toEqual({ id: c.id, value: expectedValue });
            const money = MONEY_METRIC.test(figure?.metric ?? "");
            expect({ id: c.id, ref: cell.ref, currency: cell.currency }).toEqual({ id: c.id, ref: cell.ref, currency: money ? figure?.currency : undefined });
          }
        }
        for (const citation of body.citations) expect(pack.has(citation.ref)).toBe(true);
      }
    });

    it("G-S2: money is numeric(19,4) text, ratios are 4-digit text, counts are integers", () => {
      for (const c of answers) {
        for (const f of c.evidence?.figures ?? []) {
          const metric = f.metric;
          if (MONEY_METRIC.test(metric)) expect(f.value).toMatch(/^-?\d+\.\d{4}$/);
          if (/share$|deltaRatio$/.test(metric)) expect(f.value).toMatch(/^-?\d\.\d{4}$/);
          if (/(^|\.)count$|storesWithoutSales$|rank$|baselineRank$/i.test(metric)) expect(Number.isInteger(f.value)).toBe(true);
        }
      }
    });

    it("G-S2: notices follow the figures (multi_currency, day_in_progress, day_not_begun, scope_relative_ratio) and received_only is always present", () => {
      for (const c of answers) {
        const body = bodyOf(c) as AnswerBody;
        const figures = c.evidence?.figures ?? [];
        const currencies = new Set(body.blocks.flatMap((b) => (b.type === "table" ? b.rows.flat().flatMap((cell) => (cell.currency ? [cell.currency] : [])) : [])));
        const inProgress = figures.some((f) => (f.metric === "dayState" && f.value === "so_far") || (f.metric === "currentBusinessDate" && body.period.to >= String(f.value)));
        const notBegun = figures.some((f) => f.metric === "dayState" && f.value === "not_begun");
        const scopeRelative = body.scope.mode === "stores" && figures.some((f) => /ranking\.(share|rank)$/.test(f.metric));
        expect(body.notices).toContain("received_only");
        expect({ id: c.id, multi: body.notices.includes("multi_currency") }).toEqual({ id: c.id, multi: currencies.size > 1 });
        expect({ id: c.id, inProgress: body.notices.includes("day_in_progress") }).toEqual({ id: c.id, inProgress });
        expect({ id: c.id, notBegun: body.notices.includes("day_not_begun") }).toEqual({ id: c.id, notBegun });
        expect({ id: c.id, scopeRelative: body.notices.includes("scope_relative_ratio") }).toEqual({ id: c.id, scopeRelative });
      }
    });

    it("G-S5: injection cases carry the untrusted text in the question or in a store name, and the outcome ignores it", () => {
      const injection = MSX_CASES.filter((c) => /^Injection/.test(c.category));
      expect(injection.map((c) => c.id)).toEqual(["case-22", "case-23", "case-37"]);
      for (const c of MSX_CASES.filter((x) => x.untrusted !== null)) {
        const u = c.untrusted;
        if (u === null) continue;
        if (u.where === "question") expect(String(c.request["question"])).toContain(u.text);
        else expect((c.evidence?.figures ?? []).some((f) => f.metric.endsWith("storeName") && f.value === u.text)).toBe(true);
      }
      for (const c of injection) expect(c.untrusted).not.toBeNull();
      expect(caseOf("case-21").untrusted).toEqual({ where: "question", text: NAME_B1 });
      expect(caseOf("case-23").expected).toMatchObject({ kind: "refusal", code: "finance_source_absent" });
    });

    it("G-S5: a hostile store name is rendered as data, and bidi controls never reach an expected body", () => {
      const raw = caseOf("case-37").untrusted?.text ?? "";
      expect(hasBidi(raw)).toBe(true);
      for (const c of MSX_CASES) expect(hasBidi(JSON.stringify(bodyOf(c) ?? {}))).toBe(false);
      const body = bodyOf(caseOf("case-37")) as AnswerBody;
      const names = body.blocks.flatMap((b) => (b.type === "table" ? b.rows.flat().map((cell) => cell.value) : []));
      expect(names).toContain(stripBidi(raw));
    });
  });

  describe("coverage", () => {
    it("covers Egyptian Arabic, Gulf Arabic and English with the RT-1526 section 6 split (11, 8, 19)", () => {
      const count = (lang: string): number => MSX_CASES.filter((c) => c.language === lang).length;
      for (const lang of MSX_LANGUAGES) expect(count(lang)).toBeGreaterThan(0);
      expect({ egy: count("ar-EG"), gulf: count("ar-Gulf"), en: count("en") }).toEqual({ egy: 11, gulf: 8, en: 19 });
    });

    it("keeps every section 6 coverage family: leakage, injection, stale or missing data, refusals", () => {
      const ids = (cat: RegExp): string[] => MSX_CASES.filter((c) => cat.test(c.category)).map((c) => c.id);
      expect(ids(/leakage/)).toEqual(["case-18", "case-19", "case-20", "case-21"]);
      expect(ids(/^Injection/)).toEqual(["case-22", "case-23", "case-37"]);
      expect(ids(/stale|Partial|Missing data|Evidence failure/i)).toEqual(["case-02", "case-16", "case-17", "case-30", "case-31", "case-32"]);
      expect(MSX_CASES.filter((c) => c.expected.status === 200 && c.expected.kind === "refusal").map((c) => c.id)).toEqual([
        "case-23", "case-24", "case-25", "case-26", "case-27", "case-28",
      ]);
    });
  });

  describe("synthetic data only", () => {
    it("contains nothing shaped like an email, a phone number, a token, a credential header or a real tenant name", () => {
      const text = JSON.stringify(MSX_CASES).replace(/0191e540-0000-7000-8000-[0-9a-f]{12}/g, "");
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text).not.toMatch(/(?:\+|\b00)\d{8,}|\b\d{10,}\b|\b\d{3}[ -]\d{3}[ -]\d{4}\b/);
      expect(text).not.toMatch(/\b(?:sk|pk|ghp|gho|xox[a-z]|AKIA|eyJ)[-_A-Za-z0-9]{8,}/);
      expect(text).not.toMatch(/\b[A-Fa-f0-9]{32,}\b|[A-Za-z0-9+/_-]{40,}/);
      expect(text).not.toMatch(/Bearer\s|Authorization|Cookie|dp2_session/i);
    });

    it("uses only the fixed synthetic tenant and store ids", () => {
      const text = JSON.stringify(MSX_CASES);
      const known = new Set([TENANT_A, TENANT_B, STORE_A1, STORE_A2, STORE_A3, STORE_B1]);
      for (const uuid of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []) expect(known.has(uuid)).toBe(true);
    });
  });
});
