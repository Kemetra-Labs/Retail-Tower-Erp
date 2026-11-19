/**
 * RT-1312 Phase 3(b), slice B: the Console quarantine service without a
 * database. `runWithTenantContext` is mocked to run its callback against a
 * scripted client, so this pins the in-process branches: the projection, the
 * list's parameters and paging, the store-scope predicate and the write-off's
 * 404 / 409 / success paths. The SQL itself (RLS, the state CHECKs,
 * concurrency) is proven by `sale-quarantine-ops.integration.spec.ts` against
 * real Postgres. The column-level UPDATE grants are NOT exercised there (the
 * test role has a table-wide UPDATE): the write-off's SET list (`state`,
 * `resolved_at`, `write_off_note`) is checked against
 * `SALE_QUARANTINE_UPDATABLE_COLUMNS` below instead.
 */
let clientQuery: jest.Mock;
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: (_pool: unknown, _ctx: unknown, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: clientQuery }),
}));

import { SALE_QUARANTINE_UPDATABLE_COLUMNS } from "../../../src/auth/grants/sale-quarantine-items.grants";
import {
  QuarantineNotFoundError,
  SaleQuarantineOpsService,
  toQuarantinedSaleBody,
} from "../../../src/catalog/sale-sync-ops/sale-quarantine-ops.service";
import { RepairConflictError } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.read-model.service";

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const STORE = "0a000000-0000-7000-8000-0000000000b1";
const STORE_2 = "0a000000-0000-7000-8000-0000000000b2";
const REF = "0190f0f0-0000-7000-8000-00000000c001";
const REF_2 = "0190f0f0-0000-7000-8000-00000000c002";
const AT = new Date("2026-11-11T10:00:00.000Z");
const LATER = new Date("2026-11-12T10:00:00.000Z");

const ctx = (storeAccess: unknown) =>
  ({
    tenantId: TENANT,
    context: { tenantId: TENANT, storeId: null, userId: "u1", isPlatformAdmin: false, source: "session", storeAccess },
  }) as never;
const ALL = ctx({ kind: "all" });
const ONLY_STORE = ctx({ kind: "specific", storeIds: [STORE] });
const memberships = { findRoleCodeForUserInTenant: async () => "owner" } as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: REF,
  store_id: STORE,
  device_id: "0a000000-0000-7000-8000-0000000000d1",
  source_system: "pos-pulse",
  external_id: "ext-1",
  reason_kind: "refused",
  till_http_status: 422,
  till_error_code: "sale_tender_mismatch",
  state: "open",
  received_at: AT,
  till_recorded_at: AT,
  previous_terminal_id: null,
  repair_count: 0,
  last_repair_at: null,
  last_repair_outcome: null,
  last_repair_http_status: null,
  last_repair_error_code: null,
  upload_conflict_count: 0,
  sale_id: null,
  summary_occurred_at: AT,
  summary_pos_total: "125.50",
  summary_currency_code: "EGP",
  summary_line_count: 3,
  resolved_at: null,
  write_off_note: null,
  ...over,
});

const service = (): SaleQuarantineOpsService => new SaleQuarantineOpsService({} as never, memberships);

beforeEach(() => {
  clientQuery = jest.fn();
});

describe("toQuarantinedSaleBody", () => {
  it("projects an open item with no repair, sale or write-off", () => {
    expect(toQuarantinedSaleBody(row() as never)).toEqual({
      quarantineRef: REF,
      storeId: STORE,
      deviceId: "0a000000-0000-7000-8000-0000000000d1",
      sourceSystem: "pos-pulse",
      externalId: "ext-1",
      reasonKind: "refused",
      tillHttpStatus: 422,
      tillErrorCode: "sale_tender_mismatch",
      state: "open",
      receivedAt: "2026-11-11T10:00:00.000Z",
      tillRecordedAt: "2026-11-11T10:00:00.000Z",
      previousTerminalId: null,
      repairCount: 0,
      lastRepair: null,
      uploadConflictCount: 0,
      saleRef: null,
      summary: { occurredAt: "2026-11-11T10:00:00.000Z", posTotal: "125.50", currencyCode: "EGP", lineCount: 3 },
      writeOff: null,
    });
  });

  it("never carries the stored body, a tenant, or an amount beyond the summary's POS total", () => {
    const keys = Object.keys(toQuarantinedSaleBody(row({ sale_body: { secret: 1 }, tenant_id: TENANT }) as never));
    expect(keys).not.toContain("saleBody");
    expect(keys).not.toContain("sale_body");
    expect(keys.join(",")).not.toMatch(/tenant|total|amount/i);
  });

  it("keeps a summary whose every field is unknown as nulls", () => {
    const body = toQuarantinedSaleBody(
      row({ summary_occurred_at: null, summary_pos_total: null, summary_currency_code: null, summary_line_count: null }) as never,
    );
    expect(body.summary).toEqual({ occurredAt: null, posTotal: null, currencyCode: null, lineCount: null });
  });

  it("projects the latest repair, a refused one with its status and code", () => {
    const body = toQuarantinedSaleBody(
      row({
        repair_count: 2,
        last_repair_at: LATER,
        last_repair_outcome: "refused",
        last_repair_http_status: 422,
        last_repair_error_code: "repair_operator_unproven",
      }) as never,
    );
    expect(body.repairCount).toBe(2);
    expect(body.lastRepair).toEqual({
      at: "2026-11-12T10:00:00.000Z",
      outcome: "refused",
      httpStatus: 422,
      errorCode: "repair_operator_unproven",
    });
  });

  it("projects a captured item with its sale", () => {
    const body = toQuarantinedSaleBody(
      row({ state: "captured", sale_id: REF_2, resolved_at: LATER, repair_count: 1, last_repair_at: LATER, last_repair_outcome: "captured" }) as never,
    );
    expect(body).toMatchObject({ state: "captured", saleRef: REF_2, writeOff: null });
    expect(body.lastRepair).toEqual({ at: "2026-11-12T10:00:00.000Z", outcome: "captured", httpStatus: null, errorCode: null });
  });

  it("projects the write-off from the resolution time and the note", () => {
    const body = toQuarantinedSaleBody(
      row({ state: "written-off", resolved_at: LATER, write_off_note: "refunded in cash" }) as never,
    );
    expect(body.writeOff).toEqual({ at: "2026-11-12T10:00:00.000Z", note: "refunded in cash" });
    expect(body.saleRef).toBeNull();
  });
});

describe("SaleQuarantineOpsService.list", () => {
  const input = (over: Record<string, unknown> = {}) => ({ ...(ALL as object), cursor: null, limit: 50, ...over }) as never;

  it("lists open items by default, tenant-wide, with every predicate as a parameter", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [row()] });
    const page = await service().list(input());
    expect(page).toEqual({ items: [toQuarantinedSaleBody(row() as never)], nextCursor: null });
    const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM sale_quarantine_items/);
    expect(sql).toMatch(/ORDER BY id DESC/);
    expect(sql).not.toMatch(/sale_body/);
    // The scope, the tenant and the state are predicates of the query itself, not a post-filter.
    expect(sql).toMatch(/\(\$5::uuid\[\] IS NULL OR store_id = ANY\(\$5::uuid\[\]\)\)/);
    expect(sql).toMatch(/tenant_id = \$1::uuid\s+AND state = \$2/);
    // tenant, state, store filter, cursor, store scope (null = tenant-wide), limit
    expect(params).toEqual([TENANT, "open", null, null, null, 50]);
  });

  it("passes the state, the store filter, the cursor and the granted stores", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });
    await service().list({ ...(ONLY_STORE as object), state: "written-off", storeId: STORE, cursor: REF, limit: 10 } as never);
    expect((clientQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual([
      TENANT,
      "written-off",
      STORE,
      REF,
      [STORE],
      10,
    ]);
  });

  it("an empty store scope matches no row (an empty array, never null)", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });
    const page = await service().list({ ...(ctx({ kind: "specific", storeIds: [] }) as object), cursor: null, limit: 50 } as never);
    expect(page).toEqual({ items: [], nextCursor: null });
    expect((clientQuery.mock.calls[0] as [string, unknown[]])[1][4]).toEqual([]);
  });

  it("gives the last id as the cursor only when the page is full", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [row({ id: REF_2 }), row({ id: REF })] });
    expect((await service().list(input({ limit: 2 }))).nextCursor).toBe(REF);
    clientQuery.mockResolvedValueOnce({ rows: [row({ id: REF_2 })] });
    expect((await service().list(input({ limit: 2 }))).nextCursor).toBeNull();
  });

  it("clamps the limit to 1..200", async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    await service().list(input({ limit: 5000 }));
    await service().list(input({ limit: 0 }));
    expect((clientQuery.mock.calls[0] as [string, unknown[]])[1][5]).toBe(200);
    expect((clientQuery.mock.calls[1] as [string, unknown[]])[1][5]).toBe(1);
  });
});

describe("SaleQuarantineOpsService.get", () => {
  it("returns the item projection, reading with the scope predicate and no row lock", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [row({ state: "captured", sale_id: REF_2, resolved_at: LATER })] });
    const body = await service().get(ONLY_STORE as never, REF);
    expect(body.quarantineRef).toBe(REF);
    expect(body.state).toBe("captured");
    const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/sale_body/);
    expect(params).toEqual([TENANT, REF, [STORE]]);
  });

  it("an item outside the scope or absent is the same QuarantineNotFoundError", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });
    await expect(service().get(ctx({ kind: "specific", storeIds: [STORE_2] }) as never, REF)).rejects.toBeInstanceOf(
      QuarantineNotFoundError,
    );
  });
});

describe("SaleQuarantineOpsService.writeOff", () => {
  it("writes off an open item: a locking scoped read, then one conditional UPDATE", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [row({ state: "written-off", resolved_at: LATER, write_off_note: "refunded in cash" })] });
    const body = await service().writeOff(ONLY_STORE as never, REF, "refunded in cash");
    expect(body).toMatchObject({ state: "written-off", saleRef: null, writeOff: { at: "2026-11-12T10:00:00.000Z", note: "refunded in cash" } });
    const [readSql, readParams] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(readSql).toMatch(/FOR UPDATE/);
    expect(readParams).toEqual([TENANT, REF, [STORE]]);
    const [writeSql, writeParams] = clientQuery.mock.calls[1] as [string, unknown[]];
    expect(writeSql).toMatch(/SET state = 'written-off', resolved_at = now\(\), write_off_note = \$3/);
    expect(writeSql).toMatch(/AND state = 'open'/);
    // Nothing but the mutable columns: never the body, the provenance or the scope.
    expect(writeSql).not.toMatch(/sale_body|body_purged_at|store_id =|source_system =/);
    // Every column it sets is one the domain role may UPDATE (the 0093 column grants).
    const set = /SET (.*?)\s+WHERE/s.exec(writeSql)![1]!;
    const columns = set.split(",").map((assignment) => assignment.split("=")[0]!.trim());
    expect(columns).toEqual(["state", "resolved_at", "write_off_note"]);
    for (const column of columns) expect(SALE_QUARANTINE_UPDATABLE_COLUMNS).toContain(column);
    expect(writeParams).toEqual([TENANT, REF, "refunded in cash"]);
  });

  it("an item outside the scope or absent is a 404 and writes nothing", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] });
    await expect(service().writeOff(ONLY_STORE as never, REF, "note")).rejects.toBeInstanceOf(QuarantineNotFoundError);
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it.each(["captured", "already-captured", "written-off"])("an item already %s is a conflict and writes nothing", async (state) => {
    clientQuery.mockResolvedValueOnce({ rows: [row({ state })] });
    await expect(service().writeOff(ALL as never, REF, "note")).rejects.toBeInstanceOf(RepairConflictError);
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it("an UPDATE that matches no open row is a conflict, never a false success", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [] });
    await expect(service().writeOff(ALL as never, REF, "note")).rejects.toBeInstanceOf(RepairConflictError);
  });
});
