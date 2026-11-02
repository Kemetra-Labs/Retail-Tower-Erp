import type { SaleDetail } from "@/lib/sale-queries";
import {
  classifyPostingRepair,
  failureViews,
  keepsPostingKey,
  newPostingKey,
  repairHandleOf,
} from "@/posting-repair/postingFailureLogic";
import { describe, expect, test } from "vitest";
import {
  REASON,
  REQUEST_ID,
  WORK_ITEM,
  answered,
  categoryOnly,
  failedDetail,
  failureDetail,
  full,
  recorded,
  refused,
} from "./posting-failure-fixtures";

/** RT-1072 (RT-977 §5, §7): disclosure tiers, the repair handle, and every repair outcome. */
const views = (failure?: unknown, erp: Record<string, unknown> = {}) =>
  failureViews(failedDetail(failure, erp) as unknown as SaleDetail);

describe("failureViews: disclosure tiers (RT-977 D2, §7)", () => {
  test("full: cause, reason, time and the repair handle", () => {
    const [view] = views(full());
    expect(view).toMatchObject({
      kind: "detail",
      side: "sale",
      disclosure: "full",
      causeKey: "postingRepair.cause.validation",
      reason: REASON,
      deadLetteredAt: "2026-10-07T11:00:00Z",
      workItemRef: WORK_ITEM,
      mappingHint: false,
    });
  });

  test("category_only: the category and time; never the reason, document or handle, even if sent", () => {
    const [view] = views(
      categoryOnly(
        failureDetail({
          rejectionCategory: "reconciliation_required",
          reconciliationDocumentRef: { doctype: "Sales Invoice", name: "ACC-SINV-1" },
        }),
      ),
    );
    expect(view).toMatchObject({
      kind: "detail",
      disclosure: "category_only",
      causeKey: "postingRepair.cause.reconciliationRequired",
      reason: null,
      document: null,
      workItemRef: null,
      mappingHint: false,
    });
    const [plain] = views(categoryOnly());
    expect(plain).toMatchObject({ reason: null, workItemRef: null });
  });

  test("full + reconciliation_required: the document is shown, and repair is never offered", () => {
    const document = { doctype: "Sales Invoice", name: "ACC-SINV-1" };
    const [view] = views(
      full(
        failureDetail({
          rejectionCategory: "reconciliation_required",
          reconciliationDocumentRef: document,
          // Even a handle sent by mistake is not offered (RT-332).
          repair: { workItemRef: WORK_ITEM },
        }),
      ),
    );
    expect(view).toMatchObject({
      causeKey: "postingRepair.cause.reconciliationRequiredWithDocument",
      document,
      workItemRef: null,
    });
  });

  test("full with no handle (a deleted store): no repair", () => {
    const [view] = views(full(failureDetail({ repair: null })));
    expect(view).toMatchObject({ disclosure: "full", workItemRef: null, mappingHint: false });
  });

  test.each([
    ["unmapped_item", "postingRepair.cause.unmappedItem", true],
    ["unmapped_store", "postingRepair.cause.unmappedStore", true],
    ["unmapped_account", "postingRepair.cause.unmappedAccount", false],
    ["validation", "postingRepair.cause.validation", false],
    ["closed_period", "postingRepair.cause.closedPeriod", false],
    ["retry_budget_exhausted", "postingRepair.cause.retryBudgetExhausted", false],
    ["other", "postingRepair.cause.other", false],
    ["a_future_category", "postingRepair.cause.other", false],
    [null, "postingRepair.cause.other", false],
    ["toString", "postingRepair.cause.other", false],
  ])("category %s → %s (mapping hint: %s)", (category, key, hint) => {
    const [view] = views(full(failureDetail({ rejectionCategory: category })));
    expect(view).toMatchObject({ causeKey: key, mappingHint: hint });
  });

  test("an absent field (an older server) is the RT-974 state-only banner", () => {
    expect(views(undefined)).toEqual([
      expect.objectContaining({ kind: "state-only", side: "sale" }),
    ]);
  });

  test("a failed side the probe did not find reads as changed (null field or null side)", () => {
    expect(views(null)[0].kind).toBe("changed");
    expect(views(full(null))[0].kind).toBe("changed");
  });

  test("nothing failed: no view, whatever the field says", () => {
    expect(views(full(), { sale: "posted" })).toEqual([]);
  });

  test("the void reversal side, the sale's first when both failed", () => {
    const reversal = failureDetail({ repair: { workItemRef: "rev" } });
    const both = views(full(failureDetail(), reversal), { reversal: "failed" });
    expect(both.map((v) => [v.side, v.whatKey])).toEqual([
      ["sale", "sales.erpFailure.sale"],
      ["reversal", "sales.erpFailure.reversal"],
    ]);
    expect(both[1]).toMatchObject({ workItemRef: "rev" });
  });

  test("repairHandleOf: full and a handle and not reconciliation_required", () => {
    expect(repairHandleOf("full", failureDetail() as never)).toBe(WORK_ITEM);
    expect(repairHandleOf("category_only", failureDetail() as never)).toBeNull();
    expect(
      repairHandleOf(
        "full",
        failureDetail({ rejectionCategory: "reconciliation_required" }) as never,
      ),
    ).toBeNull();
  });
});

describe("classifyPostingRepair: keyed on outcome, never on 200 vs 201 (RT-977 §5, §7)", () => {
  test.each([201, 200])("eligible_again (%i)", (status) => {
    expect(classifyPostingRepair(answered(status, recorded()) as never)).toMatchObject({
      kind: "eligible-again",
      messageKey: "postingRepair.outcome.eligibleAgain",
      variant: "success",
    });
  });

  test.each([201, 200])("still_failing (%i)", (status) => {
    expect(
      classifyPostingRepair(answered(status, recorded({ outcome: "still_failing" })) as never),
    ).toMatchObject({ kind: "still-failing", messageKey: "postingRepair.outcome.stillFailing" });
  });

  test("no_op_echo with a document: already posted, with the document", () => {
    expect(
      classifyPostingRepair(
        answered(200, recorded({ outcome: "no_op_echo", resolvedDocumentRef: "ACC-1" })) as never,
      ),
    ).toMatchObject({
      kind: "already-posted",
      messageKey: "postingRepair.outcome.alreadyPosted",
      documentRef: "ACC-1",
    });
  });

  test("no_op_echo with no document: already sent", () => {
    expect(
      classifyPostingRepair(answered(200, recorded({ outcome: "no_op_echo" })) as never),
    ).toMatchObject({ kind: "already-sent", messageKey: "postingRepair.outcome.alreadySent" });
  });

  test.each([
    [404, "x", "not-found", "postingRepair.outcome.notFound"],
    [409, "idempotency_key_conflict", "key-conflict", "postingRepair.outcome.keyConflict"],
    [403, "origin_rejected", "origin-rejected", "postingRepair.outcome.originRejected"],
    [403, "x", "forbidden", "postingRepair.outcome.forbidden"],
    [401, "x", "session", "postingRepair.outcome.session"],
    [400, "x", "rejected", "postingRepair.outcome.rejected"],
    [500, "x", "unconfirmed", "postingRepair.outcome.unconfirmed"],
    [503, "x", "unconfirmed", "postingRepair.outcome.unconfirmed"],
    [425, "idempotency_in_progress", "in-progress", "postingRepair.outcome.unconfirmed"],
  ])("%i %s → %s", (status, code, kind, key) => {
    expect(classifyPostingRepair(refused(status, code) as never)).toMatchObject({
      kind,
      messageKey: key,
      requestId: REQUEST_ID,
    });
  });

  test("429 keeps the server's wait", () => {
    expect(classifyPostingRepair(refused(429, "rate_limited", 12) as never)).toMatchObject({
      kind: "rate-limited",
      retryAfter: 12,
    });
  });

  test("no response at all, or an unknown outcome, is unconfirmed (never failed)", () => {
    expect(classifyPostingRepair({ status: 0 }).kind).toBe("unconfirmed");
    expect(
      classifyPostingRepair(answered(201, recorded({ outcome: "mystery" })) as never).kind,
    ).toBe("unconfirmed");
  });

  test("the key is kept only to retry the same confirmation", () => {
    const keeps = (result: unknown) => keepsPostingKey(classifyPostingRepair(result as never));
    expect(keeps({ status: 0 })).toBe(true);
    expect(keeps(refused(503))).toBe(true);
    expect(keeps(refused(429))).toBe(true);
    expect(keeps(refused(425))).toBe(true);
    expect(keeps(answered(201, recorded()))).toBe(false);
    expect(keeps(refused(409, "idempotency_key_conflict"))).toBe(false);
    expect(keeps(refused(404))).toBe(false);
  });

  test("a new key is a v4 UUID, different each time", () => {
    const a = newPostingKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newPostingKey()).not.toBe(a);
  });
});
