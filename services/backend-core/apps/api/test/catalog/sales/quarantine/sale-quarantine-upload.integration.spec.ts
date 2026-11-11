/**
 * RT-1312 Phase 3(b): `posQuarantineSale` over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real `PosDeviceAuthGuard`, controller and service. The per-device rate-limit
 * guard is admitted here (its bucket is covered by `test/auth/rate-limit.spec.ts`).
 *
 * What this proves (`pos-sales/sale-quarantine.yaml` 1.0.0-draft):
 *   - the device token is the only identity: 401 without a live one; the item's
 *     tenant, store and device are the guard's, never the body's;
 *   - a first upload is 201 with a receipt that validates against the contract
 *     and an open item with the summary and the sale-facts digest;
 *   - a repeat with the same sale facts is 200 with the same receipt, even when
 *     the fields capture leaves out of its hash differ; the first upload wins;
 *   - other facts from the same store: 409 `quarantine_conflict`, a conflict
 *     counted on the item, nothing else changed;
 *   - the same provenance from another store: the same 409, nothing counted;
 *     another tenant may hold the same provenance;
 *   - `previousTerminalId`: a revoked device of the store is accepted; one of
 *     another store, another tenant or none at all is a 400, nothing stored;
 *   - the closed body and the reason rules are 400s with nothing stored;
 *   - a body the capture rules would refuse is still stored (not validated);
 *   - the upload never reads `sales` (an already captured provenance is accepted).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import type request from "supertest";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../../../src/auth/auth.module";
import { PosDeviceAuthGuard } from "../../../../src/auth/pos-device-auth.guard";
import { PosWriteRateLimitGuard } from "../../../../src/auth/pos-write-rate-limit.guard";
import { SaleQuarantineController } from "../../../../src/catalog/sales/quarantine/sale-quarantine.controller";
import { SaleQuarantineService } from "../../../../src/catalog/sales/quarantine/sale-quarantine.service";
import { saleFactsDigest } from "../../../../src/catalog/sales/quarantine/quarantine-facts";
import { DeviceRepository } from "../../../../src/pos-operators/device.repository";
import { scopedHttpHarness } from "../../../_helpers/scoped-http-harness";
import {
  DEV_A1A,
  DEV_A1B,
  DEV_A2A,
  DEV_B1A,
  DEV_REVOKED,
  STORE_A1,
  STORE_A2,
  TENANT_A,
  TENANT_B,
  seedDeviceHealthFixture,
  type FixtureDevice,
} from "../../../device-health/__support__/device-health-fixture";

@Module({
  imports: [AuthModule],
  controllers: [SaleQuarantineController],
  providers: [
    SaleQuarantineService,
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
    { provide: PosWriteRateLimitGuard, useValue: { canActivate: () => true } },
  ],
})
class QuarantineUploadTestModule {}

const PATH = "/api/pos/v1/quarantined-sales";

const h = scopedHttpHarness({
  label: "RT-1312 quarantine upload",
  contractId: "sale-quarantine",
  module: QuarantineUploadTestModule,
  seed: seedDeviceHealthFixture,
});

const upload = (d: FixtureDevice | null, body: object): request.Test => {
  const r = h.post(PATH, null, body);
  return d === null ? r : r.set("authorization", `Bearer ${d.token}`);
};

const SALE_BODY = {
  sourceSystem: "pos-pulse",
  externalId: "ext-q-1",
  occurredAt: "2026-11-11T09:00:00.000Z",
  currencyCode: "EGP",
  posTotal: "150.50",
  lines: [{ productId: "p1", quantity: "1", unitPrice: "150.50" }],
  operatorUserId: "0190f0f0-0000-7000-8000-00000000c001",
  receipt: { operatorName: "Cashier One" },
};

const UPLOAD = {
  sourceSystem: "pos-pulse",
  externalId: "ext-q-1",
  idempotencyKey: "ext-q-1-capture-key",
  reason: { kind: "refused", httpStatus: 422, errorCode: "sale_tender_mismatch" },
  tillRecordedAt: "2026-11-11T09:05:00.000+02:00",
  previousTerminalId: null,
  saleBody: SALE_BODY,
};

interface ItemRow {
  id: string;
  tenant_id: string;
  store_id: string;
  device_id: string;
  previous_terminal_id: string | null;
  reason_kind: string;
  till_http_status: number | null;
  till_error_code: string | null;
  idempotency_key: string;
  sale_body: Record<string, unknown> | null;
  facts_digest: string;
  summary_occurred_at: Date | null;
  summary_pos_total: string | null;
  summary_currency_code: string | null;
  summary_line_count: number | null;
  state: string;
  upload_conflict_count: number;
}

async function items(admin: Pool): Promise<ItemRow[]> {
  return (await admin.query<ItemRow>(`SELECT * FROM sale_quarantine_items ORDER BY tenant_id, external_id`)).rows;
}

beforeEach(async () => {
  if (h.skipped()) return;
  await h.env().admin.query(`DELETE FROM sale_quarantine_items`);
});

describe("RT-1312 quarantine upload: authentication", () => {
  it("refuses a missing, unknown or revoked device token with the generic 401 and stores nothing", async () => {
    if (h.skipped()) return;
    // One request at a time (supertest shares the not-yet-listening server).
    expect((await upload(null, UPLOAD)).status).toBe(401);
    expect((await h.post(PATH, null, UPLOAD).set("authorization", "Bearer not-a-device-token-aaaaaaaa")).status).toBe(401);
    expect((await upload(DEV_REVOKED, UPLOAD)).status).toBe(401);
    expect(await items(h.env().admin)).toEqual([]);
  });
});

describe("RT-1312 quarantine upload: first upload and repeats", () => {
  it("stores a first upload under the device's tenant, store and device: 201 with a contract receipt", async () => {
    if (h.skipped()) return;
    const res = await upload(DEV_A1A, UPLOAD);
    expect(res.status).toBe(201);
    h.conforms("QuarantineReceipt", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    const [row, ...rest] = await items(h.env().admin);
    expect(rest).toEqual([]);
    expect(res.body).toEqual({ quarantineRef: row!.id, state: "open", receivedAt: expect.any(String) });
    expect(row).toMatchObject({
      tenant_id: TENANT_A,
      store_id: STORE_A1,
      device_id: DEV_A1A.id,
      previous_terminal_id: null,
      reason_kind: "refused",
      till_http_status: 422,
      till_error_code: "sale_tender_mismatch",
      idempotency_key: "ext-q-1-capture-key",
      sale_body: SALE_BODY,
      facts_digest: saleFactsDigest(SALE_BODY),
      summary_pos_total: "150.50",
      summary_currency_code: "EGP",
      summary_line_count: 1,
      state: "open",
      upload_conflict_count: 0,
    });
    expect(row!.summary_occurred_at?.toISOString()).toBe("2026-11-11T09:00:00.000Z");
    // The id is a UUIDv7 (the Console cursor relies on it).
    expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("answers a repeat with the same sale facts 200 with the same receipt; the first upload wins for the rest", async () => {
    if (h.skipped()) return;
    const first = await upload(DEV_A1A, UPLOAD);
    expect(first.status).toBe(201);
    // Another device of the same store, another reason, and the fields capture leaves out of its hash differ.
    const repeat = await upload(DEV_A1B, {
      ...UPLOAD,
      idempotencyKey: "another-capture-key-x",
      reason: { kind: "refused", httpStatus: null, errorCode: null },
      saleBody: { ...SALE_BODY, operatorUserId: "0190f0f0-0000-7000-8000-00000000c002", receipt: { operatorName: "Other" } },
    });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual(first.body);
    h.conforms("QuarantineReceipt", repeat.body);
    const [row] = await items(h.env().admin);
    expect(row).toMatchObject({ device_id: DEV_A1A.id, idempotency_key: "ext-q-1-capture-key", till_http_status: 422, sale_body: SALE_BODY });
  });

  it("refuses other sale facts from the same store with 409 quarantine_conflict and counts the conflict", async () => {
    if (h.skipped()) return;
    expect((await upload(DEV_A1A, UPLOAD)).status).toBe(201);
    for (let i = 0; i < 2; i += 1) {
      const res = await upload(DEV_A1A, { ...UPLOAD, saleBody: { ...SALE_BODY, posTotal: "999.00" } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("quarantine_conflict");
    }
    const [row] = await items(h.env().admin);
    expect(row).toMatchObject({ upload_conflict_count: 2, sale_body: SALE_BODY, summary_pos_total: "150.50" });
  });

  it("answers the same provenance from another store with the same 409 and counts nothing", async () => {
    if (h.skipped()) return;
    expect((await upload(DEV_A1A, UPLOAD)).status).toBe(201);
    const same = await upload(DEV_A2A, UPLOAD);
    const other = await upload(DEV_A2A, { ...UPLOAD, saleBody: { ...SALE_BODY, posTotal: "1.00" } });
    for (const res of [same, other]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("quarantine_conflict");
    }
    // Non-disclosing: the same body whether or not the facts match.
    expect(same.body.error.message).toBe(other.body.error.message);
    const rows = await items(h.env().admin);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_id: STORE_A1, upload_conflict_count: 0 });
  });

  it("lets another tenant quarantine the same provenance", async () => {
    if (h.skipped()) return;
    expect((await upload(DEV_A1A, UPLOAD)).status).toBe(201);
    expect((await upload(DEV_B1A, UPLOAD)).status).toBe(201);
    expect((await items(h.env().admin)).map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it("converges concurrent first uploads of one provenance to one item (one 201, the rest 200)", async () => {
    if (h.skipped()) return;
    const results = await Promise.all([upload(DEV_A1A, UPLOAD), upload(DEV_A1B, UPLOAD), upload(DEV_A1A, UPLOAD)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await items(h.env().admin)).toHaveLength(1);
  });
});

describe("RT-1312 quarantine upload: the earlier pairing", () => {
  const held = (previousTerminalId: string | null): object => ({
    ...UPLOAD,
    reason: { kind: "held_previous_pairing", httpStatus: null, errorCode: null },
    previousTerminalId,
  });

  it("accepts a revoked device of the same store as the earlier pairing", async () => {
    if (h.skipped()) return;
    const res = await upload(DEV_A1A, held(DEV_REVOKED.id));
    expect(res.status).toBe(201);
    const [row] = await items(h.env().admin);
    expect(row).toMatchObject({ reason_kind: "held_previous_pairing", previous_terminal_id: DEV_REVOKED.id });
  });

  it.each([
    ["a device of another store", DEV_A2A.id],
    ["a device of another tenant", DEV_B1A.id],
    ["an unknown device", "0190f0f0-0000-7000-8000-0000000000ff"],
  ])("refuses %s with 400 validation_error and stores nothing", async (_label, deviceId) => {
    if (h.skipped()) return;
    const res = await upload(DEV_A1A, held(deviceId));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(await items(h.env().admin)).toEqual([]);
  });

  it("refuses a held sale without the earlier pairing", async () => {
    if (h.skipped()) return;
    expect((await upload(DEV_A1A, held(null))).status).toBe(400);
    expect(await items(h.env().admin)).toEqual([]);
  });
});

describe("RT-1312 quarantine upload: the closed body and the reason rules", () => {
  it.each<[string, object]>([
    ["an unknown key", { ...UPLOAD, extra: 1 }],
    ["a tenant id", { ...UPLOAD, tenantId: TENANT_B }],
    ["a store id", { ...UPLOAD, storeId: STORE_A2 }],
    ["a device id", { ...UPLOAD, deviceId: DEV_A2A.id }],
    ["a missing saleBody", { ...UPLOAD, saleBody: undefined }],
    ["an array saleBody", { ...UPLOAD, saleBody: [1] }],
    ["a saleBody of another provenance", { ...UPLOAD, saleBody: { ...SALE_BODY, externalId: "ext-other" } }],
    ["a saleBody of another source", { ...UPLOAD, saleBody: { ...SALE_BODY, sourceSystem: "other" } }],
    ["a short idempotency key", { ...UPLOAD, idempotencyKey: "short" }],
    ["a retried status (429)", { ...UPLOAD, reason: { kind: "refused", httpStatus: 429, errorCode: null } }],
    ["a 5xx status", { ...UPLOAD, reason: { kind: "refused", httpStatus: 503, errorCode: null } }],
    ["a divergence that is not 409", { ...UPLOAD, reason: { kind: "payload_divergence", httpStatus: 422, errorCode: null } }],
    ["a claim refusal that is not 403", { ...UPLOAD, reason: { kind: "cashier_claim_refused", httpStatus: 422, errorCode: null } }],
    ["a held sale with a status", { ...UPLOAD, previousTerminalId: DEV_REVOKED.id, reason: { kind: "held_previous_pairing", httpStatus: 422, errorCode: null } }],
    ["an error message instead of a code", { ...UPLOAD, reason: { kind: "refused", httpStatus: 422, errorCode: "Tender mismatch!" } }],
    ["a till time without an offset", { ...UPLOAD, tillRecordedAt: "2026-11-11T09:05:00" }],
  ])("refuses %s with 400 and stores nothing", async (_label, body) => {
    if (h.skipped()) return;
    const res = await upload(DEV_A1A, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(await items(h.env().admin)).toEqual([]);
  });

  it("stores a body the capture rules would refuse, with a null summary for each malformed field", async () => {
    if (h.skipped()) return;
    const broken = { sourceSystem: "pos-pulse", externalId: "ext-q-1", posTotal: 150.5, currencyCode: "egp", occurredAt: "yesterday", lines: "none" };
    const res = await upload(DEV_A1A, { ...UPLOAD, reason: { kind: "refused", httpStatus: 400, errorCode: "validation_error" }, saleBody: broken });
    expect(res.status).toBe(201);
    const [row] = await items(h.env().admin);
    expect(row).toMatchObject({
      sale_body: broken,
      summary_occurred_at: null,
      summary_pos_total: null,
      summary_currency_code: null,
      summary_line_count: null,
    });
  });

  it("accepts a body without its own provenance fields", async () => {
    if (h.skipped()) return;
    const { sourceSystem: _s, externalId: _e, ...bare } = SALE_BODY;
    expect((await upload(DEV_A1A, { ...UPLOAD, saleBody: bare })).status).toBe(201);
  });
});
