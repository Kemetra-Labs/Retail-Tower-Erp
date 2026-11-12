/**
 * RT-1353 — a restricted tenant cannot issue or complete a POS pairing, over
 * HTTP against real Postgres (every migration incl. 0105, the NOBYPASSRLS
 * `app_test` pool) and the real `DevicesModule` + `PairingModule` graph.
 *
 *   POST /api/v1/pairing-codes          consoleIssuePairingCode
 *   POST /api/pos/v1/terminals/pair     posPairTerminal
 *
 * What this proves (RT-1353 acceptance 3):
 *   - issue: a restricted tenant gets the existing non-disclosing 404
 *     `not_found` (the answer for an unknown store), writes no code and no
 *     audit row; the same request is 201 once the tenant is unrestricted;
 *   - completion: a code issued BEFORE the restriction is refused with the
 *     existing 404 INVALID_CODE (identical to an unknown code), is NOT burned
 *     (still pending) and provisions no device; once unrestricted the same
 *     code pairs (200);
 *   - an unrestricted tenant is unaffected: a tenant with no row, and a tenant
 *     whose row says `unrestricted`, issue and pair as before (the existing
 *     pairing suites stay green).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { Module } from "@nestjs/common";
import type request from "supertest";

import { DevicesModule } from "../../src/devices/devices.module";
import { PairingModule } from "../../src/pos-terminal-pairing/pairing.module";
import { BINDING, seedPairingCodeFixture } from "../devices/__support__/pairing-code-fixture";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, TENANT_A } from "../catalog/__support__/isolation-harness";
import { SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { clearAccess, restrict } from "./__support__/access-fixture";

@Module({ imports: [DevicesModule, PairingModule] })
class PairingGatesTestModule {}

const CODES = "/api/v1/pairing-codes";
const PAIR = "/api/pos/v1/terminals/pair";
const UNKNOWN_CODE = "UNKNOWN-CODE-1353";

const h = scopedHttpHarness({
  label: "RT-1353 pairing gates",
  contractId: "devices.openapi",
  module: PairingGatesTestModule,
  seed: seedPairingCodeFixture,
});
const skip = (): boolean => h.skipped();

const issue = (body: object = { storeId: STORE_A_X }): request.Test =>
  h.post(CODES, SES_OWNER_ALL, { ...BINDING, ...body }).set("Idempotency-Key", randomUUID());
const pair = (code: string): request.Test => h.post(PAIR, null, { pairing_code: code });

async function codeRows(): Promise<number> {
  const r = await h.env().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pairing_codes WHERE tenant_id = $1`, [TENANT_A]);
  return Number(r.rows[0]!.n);
}

async function auditCount(action: string): Promise<number> {
  const r = await h.env().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = $1 AND action = $2`, [TENANT_A, action]);
  return Number(r.rows[0]!.n);
}

afterEach(async () => {
  if (h.skipped()) return;
  await clearAccess(h.env().admin, TENANT_A);
});

describe("consoleIssuePairingCode while restricted", () => {
  it("is the non-disclosing 404, writes no code and no audit, and is 201 once unrestricted", async () => {
    if (skip()) return;
    const codesBefore = await codeRows();
    const auditsBefore = await auditCount("pos.device.pairing_code.issued");
    await restrict(h.env().admin, TENANT_A);

    const refused = await issue();
    const unknownStore = await issue({ storeId: randomUUID() });
    expect([refused.status, refused.body.error.code]).toEqual([404, "not_found"]);
    // The refusal says nothing the unknown-store answer does not say.
    expect(refused.body.error.message).toBe(unknownStore.body.error.message);
    expect(await codeRows()).toBe(codesBefore);
    expect(await auditCount("pos.device.pairing_code.issued")).toBe(auditsBefore);

    await clearAccess(h.env().admin, TENANT_A);
    const allowed = await issue();
    expect(allowed.status).toBe(201);
  });

  it("an unrestricted tenant is unaffected, whether it has no row or an unrestricted row", async () => {
    if (skip()) return;
    expect((await issue()).status).toBe(201);
    const admin = h.env().admin;
    await admin.query(
      `INSERT INTO tenant_access_entitlements
         (tenant_id, state, unlock_requested_at, unlock_requested_by_user_id, provisioned_at, provisioned_by_user_id, provisioning_source)
       SELECT $1, 'unrestricted', now(), u.id, now(), u.id, 'manual_platform' FROM (SELECT id FROM users LIMIT 1) u`,
      [TENANT_A],
    );
    expect((await issue()).status).toBe(201);
  });
});

describe("posPairTerminal while restricted", () => {
  it("refuses a code issued before the restriction like an unknown code, burns nothing, and pairs once unrestricted", async () => {
    if (skip()) return;
    const issued = await issue();
    expect(issued.status).toBe(201);
    const code = issued.body.code as string;
    const terminalId = issued.body.terminalId as string;

    await restrict(h.env().admin, TENANT_A);
    // More refusals than the per-code attempt budget (5): none is charged to the code.
    for (let i = 0; i < 7; i++) expect((await pair(code)).status).toBe(404);
    const refused = await pair(code);
    const unknown = await pair(UNKNOWN_CODE);
    // The same answer as an unknown code: status, code and message (the request id is per request).
    expect([refused.status, refused.body.error.code, refused.body.error.message]).toEqual([
      unknown.status,
      unknown.body.error.code,
      unknown.body.error.message,
    ]);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toMatch(/restrict|entitle|tenant/i);

    const stored = await h.env().admin.query<{ status: string }>(
      `SELECT status FROM pairing_codes WHERE id = $1`,
      [issued.body.pairingCodeId],
    );
    expect(stored.rows[0]!.status).toBe("pending");
    const attempts = await h.env().admin.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM pairing_codes WHERE id = $1`,
      [issued.body.pairingCodeId],
    );
    expect(attempts.rows[0]!.attempt_count).toBe(0);
    const devices = await h.env().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM devices WHERE id = $1`, [terminalId]);
    expect(devices.rows[0]!.n).toBe("0");

    await clearAccess(h.env().admin, TENANT_A);
    const paired = await pair(code);
    expect(paired.status).toBe(200);
    expect(paired.body.terminal_id).toBe(terminalId);
  });
});
