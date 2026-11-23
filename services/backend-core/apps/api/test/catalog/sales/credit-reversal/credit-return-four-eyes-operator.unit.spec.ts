/**
 * RT-1565 (RT-285 OQ-5) — the D6 four-eyes rule of a credit return stays bound to the Transaction Operator
 * (`sales.created_by`), not to a line's seller. Unit, no DB.
 *
 *   - the facts read the operator from `created_by` and never read the line seller columns;
 *   - an approval by the operator is refused by the claims alone (no query runs);
 *   - an approval by a member who is only a line's seller passes the claims (the next check, the approval's
 *     amount and single use, runs).
 */
import type { PoolClient } from "pg";

import {
  assertCreditReturnApproval,
  CreditReturnApprovalRefusedError,
  readCreditSaleFacts,
} from "../../../../src/catalog/sales/credit-sale-reversal.checks";

const SCOPE = { tenantId: "0a000000-0000-7000-8000-000000156501", storeId: "0a000000-0000-7000-8000-000000156502" };
const SALE = "0a000000-0000-7000-8000-000000156503";
const REQUESTER = "0a000000-0000-7000-8000-000000156504";
const OPERATOR = "0a000000-0000-7000-8000-000000156505";
const LINE_SELLER = "0a000000-0000-7000-8000-000000156506";

/** A client that records every query and answers with `rows`. */
function recordingClient(rows: unknown[]): { client: PoolClient; sql: string[] } {
  const sql: string[] = [];
  const query = jest.fn(async (text: string) => {
    sql.push(text);
    return { rows };
  });
  return { client: { query } as unknown as PoolClient, sql };
}

function approvalBy(approverUserId: string) {
  return {
    approvalId: "0a000000-0000-7000-8000-000000156507",
    action: "sale.credit_return",
    saleRef: SALE,
    amount: "1",
    requesterUserId: REQUESTER,
    approverUserId,
    policyVersion: "v1",
    approvedAt: new Date().toISOString(),
  };
}

function input(approverUserId: string) {
  return {
    scope: SCOPE,
    saleRef: SALE,
    actorUserId: REQUESTER,
    operatorUserId: OPERATOR,
    refundable: "1",
    approval: approvalBy(approverUserId),
    now: new Date(),
  };
}

describe("RT-1565 — the credit-return four-eyes rule is the operator's, not the seller's", () => {
  it("reads the operator from sales.created_by and never reads a line's seller", async () => {
    const { client, sql } = recordingClient([
      {
        pos_total: "10",
        collected: "0",
        currency_code: "EGP",
        business_date: "2026-11-23",
        created_by: OPERATOR,
        payer_id: null,
        before: "0",
        blocked: false,
      },
    ]);
    const facts = await readCreditSaleFacts(client, SALE);
    expect(facts.operatorUserId).toBe(OPERATOR);
    expect(sql.join("\n")).toContain("s.created_by");
    expect(sql.join("\n")).not.toMatch(/seller_user_id|received_by_user_id/);
  });

  it("refuses an approval by the operator on the claims alone", async () => {
    const { client, sql } = recordingClient([]);
    await expect(assertCreditReturnApproval(client, input(OPERATOR))).rejects.toBeInstanceOf(
      CreditReturnApprovalRefusedError,
    );
    expect(sql).toHaveLength(0);
  });

  it("lets an approval by a member who is only a line's seller past the claims", async () => {
    // `rows: []` fails the next check (amount and single use), so the call still refuses, but only after
    // the claims held: that check's query ran.
    const { client, sql } = recordingClient([]);
    await expect(assertCreditReturnApproval(client, input(LINE_SELLER))).rejects.toBeInstanceOf(
      CreditReturnApprovalRefusedError,
    );
    expect(sql.some((text) => text.includes("sale_approval_uses"))).toBe(true);
  });
});
