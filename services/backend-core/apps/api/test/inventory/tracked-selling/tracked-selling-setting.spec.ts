/**
 * Jira RT-451 S2 — the tenant's tracked-selling switch
 * (`getTrackedSellingSetting` / `setTrackedSellingSetting`,
 * `inventory/inventory.yaml` 1.12.0-draft; owner decisions OD-T1..OD-T7,
 * RT-451 comments 16215, 16216, 16217) against real Postgres (Testcontainers,
 * every migration, the NOBYPASSRLS `app_test` role).
 *
 * What this proves:
 *   - a tenant that never changed the switch reads OFF, never changed, with
 *     the Q13 preconditions evaluated fail-closed (the unconfirmable ones
 *     unmet) and `sale_effects_active` read from RT-427's activation;
 *   - a store_manager reads on/off only, every other field null (OD-T6);
 *   - off -> on with an unmet precondition is 409
 *     `tracked_selling_preconditions_unmet` and writes nothing (OD-T3);
 *   - with every precondition met, off -> on writes the switch with its
 *     change time and actor and one audit row, in one transaction;
 *   - a repeat in either direction writes nothing and is never a 409, and a
 *     tenant that is on stays on when a precondition later fails (OD-T7);
 *   - on -> off is always accepted, even while preconditions are unmet;
 *   - another tenant's switch is never read or changed; nothing steps the
 *     Inventory Safety Revision.
 *
 * The role read is a fake (`findRoleCodeForUserInTenant`). The "every
 * precondition met" case stands in for the build's signals with a fake
 * `TrackedSellingPreconditions`: four of the six are unconfirmable in this
 * build, so the real checks never allow switching on yet. Docker policy: hard
 * failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import 'reflect-metadata';

import { ConflictException } from '@nestjs/common';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';

import type { MembershipRepository } from '../../../src/context/membership.repository';
import {
  TrackedSellingPreconditions,
  type TrackedSellingPrecondition,
} from '../../../src/inventory/tracked-selling/tracked-selling-preconditions';
import {
  TrackedSellingSettingService,
  type TrackedSellingCaller,
} from '../../../src/inventory/tracked-selling/tracked-selling-setting.service';
import { startPgEnvOrSkip } from '../../_helpers/device-module-app';
import { allContracts, contractDocument } from '../../_helpers/openapi-contract';
import { stopPgEnv, type PgTestEnv } from '../../_helpers/postgres-container';
import { ACTOR_A, ACTOR_B, TENANT_A, TENANT_B, seedCatalogIsolationFixture } from '../../catalog/__support__/isolation-harness';

const UNCONFIRMABLE: TrackedSellingPrecondition[] = [
  'erp_tracking_import',
  'erp_batch_posting_verified',
  'identity_anchor',
  'tracking_grain_reconciliation',
];

let env: PgTestEnv | null = null;
let admin: Pool;
let real: TrackedSellingSettingService;
let allMet: TrackedSellingSettingService;
let role = 'owner';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function conforms(body: unknown): void {
  const validate = ajv.getSchema('inventory#/components/schemas/TrackedSellingSetting');
  if (!validate) throw new Error('ajv cannot resolve TrackedSellingSetting');
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

const A: TrackedSellingCaller = { tenantId: TENANT_A, userId: ACTOR_A, isPlatformAdmin: false };
const B: TrackedSellingCaller = { tenantId: TENANT_B, userId: ACTOR_B, isPlatformAdmin: false };

async function counts(): Promise<Record<string, string>> {
  const r = await admin.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM audit_events WHERE action = 'inventory.tracked_selling.update')::text AS audits,
            (SELECT count(*) FROM tenant_inventory_settings)::text AS settings,
            (SELECT COALESCE(SUM(revision), 0) FROM tenant_inventory_safety_revisions)::text AS revisions,
            (SELECT string_agg(tenant_id::text || ':' || tracked_selling_enabled::text, ',' ORDER BY tenant_id)
               FROM tenant_inventory_settings)::text AS switches`,
  );
  return r.rows[0]!;
}

async function resetSwitch(tenantId: string): Promise<void> {
  await admin.query(
    `UPDATE tenant_inventory_settings
        SET tracked_selling_enabled = false, tracked_selling_changed_at = NULL, tracked_selling_changed_by = NULL,
            sale_effects_activated_at = NULL, sale_effects_activated_by = NULL
      WHERE tenant_id = $1`,
    [tenantId],
  );
}

beforeAll(async () => {
  env = await startPgEnvOrSkip('RT-451 S2 tracked-selling switch');
  if (env === null) return;
  admin = new Pool({ connectionString: env.adminUri });
  await seedCatalogIsolationFixture(env);
  await admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'ts-a@fixture.invalid', NULL), ($2, 'ts-b@fixture.invalid', NULL)
     ON CONFLICT DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );
  const pool = env.app as unknown as Pool;
  const memberships = { findRoleCodeForUserInTenant: async () => role } as unknown as MembershipRepository;
  const met = { unmet: async () => [] } as unknown as TrackedSellingPreconditions;
  real = new TrackedSellingSettingService(pool, memberships, new TrackedSellingPreconditions());
  allMet = new TrackedSellingSettingService(pool, memberships, met);
  ajv.addSchema(contractDocument(allContracts(), 'inventory') as object, 'inventory');
}, 240_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  role = 'owner';
  if (env) {
    await resetSwitch(TENANT_A);
    await resetSwitch(TENANT_B);
  }
});

const skipped = (): boolean => env === null;

describe('reading the switch', () => {
  it('reads OFF, never changed, with the unconfirmable preconditions unmet (fail closed)', async () => {
    if (skipped()) return;
    const body = await real.getSetting(A);
    expect(body).toEqual({
      enabled: false,
      changedAt: null,
      changedBy: null,
      preconditionsMet: false,
      unmetPreconditions: ['sale_effects_active', ...UNCONFIRMABLE],
    });
    conforms(body);
  });

  it('reads sale_effects_active from the RT-427 activation; status_moves_available is met in this build', async () => {
    if (skipped()) return;
    await admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, sale_effects_activated_at, sale_effects_activated_by)
       VALUES ($1, $2, now(), $2)
       ON CONFLICT (tenant_id) DO UPDATE SET sale_effects_activated_at = now(), sale_effects_activated_by = $2`,
      [TENANT_A, ACTOR_A],
    );
    const body = await real.getSetting(A);
    expect(body.unmetPreconditions).toEqual(UNCONFIRMABLE);
    expect(body.preconditionsMet).toBe(false);
  });

  it('gives a store_manager the on/off value only (OD-T6)', async () => {
    if (skipped()) return;
    await allMet.setSetting(A, true);
    role = 'store_manager';
    const body = await real.getSetting(A);
    expect(body).toEqual({
      enabled: true,
      changedAt: null,
      changedBy: null,
      preconditionsMet: null,
      unmetPreconditions: null,
    });
    conforms(body);
  });

  it('gives a platform admin every field without a role lookup', async () => {
    if (skipped()) return;
    role = 'store_manager';
    const body = await real.getSetting({ ...A, isPlatformAdmin: true });
    expect(body.preconditionsMet).toBe(false);
    expect(body.unmetPreconditions).not.toBeNull();
  });
});

describe('switching on and off', () => {
  it('refuses off -> on with 409 tracked_selling_preconditions_unmet and writes nothing (OD-T3)', async () => {
    if (skipped()) return;
    const before = await counts();
    const refusal = await real.setSetting(A, true).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'tracked_selling_preconditions_unmet' });
    expect(await counts()).toEqual(before);
  });

  it('switches on with every precondition met, recording the change and one audit row', async () => {
    if (skipped()) return;
    const before = await counts();
    const on = await allMet.setSetting(A, true);
    expect(on).toMatchObject({ enabled: true, changedBy: ACTOR_A, preconditionsMet: true, unmetPreconditions: [] });
    expect(on.changedAt).not.toBeNull();
    conforms(on);
    const after = await counts();
    expect(Number(after.audits) - Number(before.audits)).toBe(1);
    expect(after.revisions).toBe(before.revisions);
    const audit = await admin.query<{ metadata: unknown; target_id: string }>(
      `SELECT metadata, target_id::text FROM audit_events WHERE action = 'inventory.tracked_selling.update'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    expect(audit.rows).toEqual([{ metadata: { old: false, new: true }, target_id: TENANT_A }]);
  });

  it('writes nothing for a repeat in either direction, and a repeated on is never a 409 (OD-T7)', async () => {
    if (skipped()) return;
    const off = await counts();
    expect((await real.setSetting(A, false)).enabled).toBe(false);
    expect(await counts()).toEqual(off);
    await allMet.setSetting(A, true);
    const on = await counts();
    // The real checks are unmet now, but on stays on and a repeat is a no-op.
    const again = await real.setSetting(A, true);
    expect(again).toMatchObject({ enabled: true, preconditionsMet: false });
    expect(await counts()).toEqual(on);
  });

  it('keeps a switched-on tenant on when its preconditions fail, shown as enabled with preconditionsMet false (OD-T7)', async () => {
    if (skipped()) return;
    await allMet.setSetting(A, true);
    const body = await real.getSetting(A);
    expect(body).toMatchObject({ enabled: true, preconditionsMet: false, unmetPreconditions: ['sale_effects_active', ...UNCONFIRMABLE] });
  });

  it('always accepts on -> off, even while preconditions are unmet (OD-T3), and audits it', async () => {
    if (skipped()) return;
    await allMet.setSetting(A, true);
    const before = await counts();
    const off = await real.setSetting(A, false);
    expect(off).toMatchObject({ enabled: false, changedBy: ACTOR_A });
    expect(off.changedAt).not.toBeNull();
    expect(Number((await counts()).audits) - Number(before.audits)).toBe(1);
  });
});

describe('tenant isolation', () => {
  it("never reads or changes another tenant's switch", async () => {
    if (skipped()) return;
    await allMet.setSetting(A, true);
    expect((await real.getSetting(B)).enabled).toBe(false);
    await allMet.setSetting(B, true);
    await real.setSetting(B, false);
    expect((await real.getSetting(A)).enabled).toBe(true);
    const rows = await admin.query<{ tenant_id: string; tracked_selling_changed_by: string }>(
      `SELECT tenant_id::text, tracked_selling_changed_by::text FROM tenant_inventory_settings
        WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id`,
      [[TENANT_A, TENANT_B]],
    );
    expect(rows.rows.find((r) => r.tenant_id === TENANT_A)?.tracked_selling_changed_by).toBe(ACTOR_A);
    expect(rows.rows.find((r) => r.tenant_id === TENANT_B)?.tracked_selling_changed_by).toBe(ACTOR_B);
  });
});
