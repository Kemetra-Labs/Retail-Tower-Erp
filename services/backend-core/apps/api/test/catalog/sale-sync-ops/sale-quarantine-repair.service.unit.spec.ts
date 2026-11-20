/**
 * RT-1312 Phase 3(b), slice C: the repair's decisions without a database
 * (`SaleQuarantineRepairService`). The behaviour over real Postgres is
 * `sale-quarantine-repair.integration.spec.ts`; this pins what it cannot reach
 * cheaply: a Postgres refusal of a body value is a 400 outcome, and anything
 * unexpected is rethrown with nothing recorded on the item (the transaction
 * rolls back as a whole).
 */
import "reflect-metadata";

import { ForbiddenException, InternalServerErrorException } from "@nestjs/common";

import { SaleQuarantineRepairService } from "../../../src/catalog/sale-sync-ops/sale-quarantine-repair.service";
import { RepairConflictError } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.read-model.service";
import { captureSaleInTransaction } from "../../../src/catalog/sales/sales.service";

// Only the capture step is replaced; the error classes the controller's mapper tests with `instanceof` stay real.
jest.mock("../../../src/catalog/sales/sales.service", () => ({
  ...jest.requireActual("../../../src/catalog/sales/sales.service"),
  captureSaleInTransaction: jest.fn(),
}));
jest.mock("../../../src/memberships", () => ({ wasTenantMemberAt: jest.fn().mockResolvedValue(true) }));

const capture = captureSaleInTransaction as jest.MockedFunction<typeof captureSaleInTransaction>;

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const STORE = "0a000000-0000-7000-8000-0000000000b1";
const REF = "0190f0f0-0000-7000-8000-00000000c001";
const REPAIRER = "0a000000-0000-7000-8000-0000000000c1";
const SALE = "0a000000-0000-7000-8000-0000000000d1";
const BODY = {
  sourceSystem: "pos-pulse",
  externalId: "ext-1",
  currencyCode: "USD",
  posTotal: "5.0000",
  occurredAt: "2026-11-11T09:00:00.000Z",
  lines: [{ lineName: "Widget", unitPrice: "5.0000", currencyCode: "USD", quantity: "1", lineAmount: "5.0000", unit: "ea" }],
};

function item(state = "open"): Record<string, unknown> {
  return { id: REF, store_id: STORE, device_id: "dev-1", previous_terminal_id: null, source_system: "pos-pulse", external_id: "ext-1", state };
}

/** A scripted client: the stored body, the savepoint statements, and the final UPDATE row. */
function scripted(body: unknown) {
  const calls: string[] = [];
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("SELECT sale_body")) return { rows: [{ sale_body: body }] };
      if (sql.includes("UPDATE sale_quarantine_items")) {
        const p = params ?? [];
        return {
          rows: [
            {
              ...item(),
              state: p[2],
              received_at: new Date(),
              till_recorded_at: new Date(),
              repair_count: 1,
              last_repair_at: new Date(),
              last_repair_outcome: p[5],
              last_repair_http_status: p[6],
              last_repair_error_code: p[7],
              upload_conflict_count: 0,
              sale_id: p[4],
              reason_kind: "refused",
              summary_occurred_at: null,
              summary_pos_total: null,
              summary_currency_code: null,
              summary_line_count: null,
              resolved_at: null,
              write_off_note: null,
              previous_terminal_id: null,
            },
          ],
        };
      }
      return { rows: [] };
    }),
  };
  return { client, calls };
}

function serviceOver(rowItem: Record<string, unknown>, client: unknown): SaleQuarantineRepairService {
  const items = { withLockedItem: async (_i: unknown, _r: string, fn: (c: unknown, row: unknown) => unknown) => fn(client, rowItem) };
  return new SaleQuarantineRepairService(items as never);
}

const input = { tenantId: TENANT, repairerUserId: REPAIRER, context: {} } as never;

beforeEach(() => capture.mockReset());

describe("SaleQuarantineRepairService", () => {
  it("an item that is not open is a conflict before anything runs", async () => {
    const { client } = scripted(BODY);
    await expect(serviceOver(item("captured"), client).repair(input, REF)).rejects.toBeInstanceOf(RepairConflictError);
    expect(client.query).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures as the repairer on the envelope path with the uploading device, and records the sale", async () => {
    capture.mockResolvedValue({ saleId: SALE, created: true });
    const { client, calls } = scripted(BODY);
    await serviceOver(item(), client).repair(input, REF);
    expect(capture).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ tenantId: TENANT, storeId: STORE, actorUserId: REPAIRER, deviceId: "dev-1", authPath: "envelope" }),
    );
    expect(calls).toEqual(expect.arrayContaining(["SAVEPOINT quarantine_repair_capture", "RELEASE SAVEPOINT quarantine_repair_capture", "UPDATE sale_quarantine_items SET"]));
  });

  it("a Postgres refusal of a body value (a date out of range, here under a wrapper) is a 400 validation_error outcome", async () => {
    // A node-postgres DatabaseError carries a severity; the shared classifier needs it (and walks `cause`).
    capture.mockRejectedValue(Object.assign(new Error("wrapped"), { cause: { code: "22008", severity: "ERROR" } }));
    const { client, calls } = scripted(BODY);
    await serviceOver(item(), client).repair(input, REF);
    expect(calls).toContain("ROLLBACK TO SAVEPOINT");
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE sale_quarantine_items"))!;
    expect(update[1]).toEqual(expect.arrayContaining(["open", "refused", 400, "validation_error"]));
  });

  it("a capture refusal keeps its status and code on the item, which stays open", async () => {
    capture.mockRejectedValue(new ForbiddenException({ code: "sale_responsibility_role_refused", message: "x" }));
    const { client } = scripted(BODY);
    await serviceOver(item(), client).repair(input, REF);
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE sale_quarantine_items"))!;
    expect(update[1]).toEqual(expect.arrayContaining(["open", "refused", 403, "sale_responsibility_role_refused"]));
  });

  it("an unexpected failure (5xx or unknown) is rethrown after the savepoint rollback and records nothing", async () => {
    capture.mockRejectedValue(new InternalServerErrorException());
    const { client } = scripted(BODY);
    await expect(serviceOver(item(), client).repair(input, REF)).rejects.toBeInstanceOf(InternalServerErrorException);
    const sqls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => sql.includes("UPDATE sale_quarantine_items"))).toBe(false);
  });

  it("a body whose provenance is not the item's, or that is not a capture, is refused 400 without capturing", async () => {
    for (const body of [{ ...BODY, externalId: "another" }, { nope: true }, null]) {
      const { client } = scripted(body);
      await serviceOver(item(), client).repair(input, REF);
      const update = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE sale_quarantine_items"))!;
      expect(update[1]).toEqual(expect.arrayContaining(["refused", 400, "validation_error"]));
    }
    expect(capture).not.toHaveBeenCalled();
  });
});
