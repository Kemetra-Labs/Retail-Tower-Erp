/**
 * RT-451 S6: the posting feed emits the frozen `trackingMode` /
 * `erpnextBatchRef` and holds G7-9 row-3 intents (posting-feed.yaml
 * 1.10.0-draft; sales.yaml G7-9; migration 0095).
 *
 * The seeded pending sale_post (tenant A, sale A-X) has two lines: an
 * untracked product's line and a batch product's line sold from identity
 * I_A. Each case freezes a resolution version shaped as the worker writes it,
 * points the intent at it, and pulls through the real `ErpnextPostingService`
 * as the app role (RLS). Proved:
 *   - tracked selling NOT in effect (deploy gate or tenant switch off): an
 *     intent with a tracked line is held; an untracked intent is offered with
 *     no tracking fields at all (byte-identical to the feed before S6);
 *   - tracked selling in effect: a tracked line emits `trackingMode: batch`
 *     and its frozen Batch; an untracked line emits `none` / null. The pulled
 *     work item validates against the contract's `PostingWorkItem`;
 *   - a held line (`edge_map_missing` or `expired`) is never offered, even in
 *     effect;
 *   - a batch line with no identity (captured while tracked selling was off)
 *     and a version frozen before 0095 emit no tracking fields;
 *   - a line capture classified as tracked whose version froze no tracking
 *     (written before 0095, or by a backfill) is held, never offered without
 *     its Batch;
 *   - through the real operator re-resolution: re-resolving without an
 *     edge-map row is refused as unchanged; after the edge map is repaired it
 *     releases an `edge_map_missing` hold; an `expired` lot stays held;
 *   - switching tracked selling on re-heads the held tracked intents, so a
 *     Connector whose cursor moved past them is offered them again;
 *   - the projection refuses to build a held tracked line
 *     (`TrackedLineNotPostableError`) rather than offer it without its Batch.
 *
 * Docker policy mirrors posting-feed.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { runWithTenantContext } from "@data-pulse-2/db";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  TrackedLineNotPostableError,
  buildWorkItem,
  type PostingWorkItem,
  type WorkItemLine,
} from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import {
  ErpnextPostingReResolutionService,
  ReResolveConflictError,
} from "../../../../src/catalog/erpnext-reconciliation/posting-re-resolution.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import { TrackedSellingPreconditions } from "../../../../src/inventory/tracked-selling/tracked-selling-preconditions";
import { TrackedSellingSettingService } from "../../../../src/inventory/tracked-selling/tracked-selling-setting.service";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const P_NONE = "01960000-0000-7000-8000-0000000b5001";
const P_BATCH = "01960000-0000-7000-8000-0000000b5002";
const I_A = "01960000-0000-7000-8000-0000000b5011";
const GATE = "POS_TRACKED_SELLING_ENABLED";

let env: PgTestEnv | null = null;
let skip = false;
let untrackedLine = "";
let trackedLine = "";
let itemMapNone = "";
let itemMapBatch = "";
let warehouseMap = "";
let validateWorkItem: ((v: unknown) => boolean) & { errors?: unknown } = Object.assign(() => false, {});

function pg(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-tracking.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
  const a = env.admin;
  // The audited services (re-resolution, the switch) record ACTOR_A as the actor.
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 's6-actor@fixture.invalid') ON CONFLICT (id) DO NOTHING`, [
    ACTOR_A,
  ]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $3, 'S6 untracked', 'standard', $4, $4, 'none'), ($2, $3, 'S6 batch', 'standard', $4, $4, 'batch')`,
    [P_NONE, P_BATCH, TENANT_A, ACTOR_A],
  );
  const lines = await a.query<{ id: string }>(`SELECT id FROM sale_lines WHERE sale_id = $1 ORDER BY id`, [SALE_A_X]);
  untrackedLine = lines.rows[0]!.id;
  trackedLine = lines.rows[1]!.id;
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $2, $3, 'batch', 'S6-LOT-A', '2026-12-31')`,
    [I_A, TENANT_A, P_BATCH],
  );
  await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE id = $2`, [P_NONE, untrackedLine]);
  await a.query(
    `UPDATE sale_lines SET tenant_product_ref = $1, tracking_identity_id = $2, tracking_code = 'S6-LOT-A',
            tracking_selection = 'scanned', tracking_class = 'flagged'
      WHERE id = $3`,
    [P_BATCH, I_A, trackedLine],
  );
  await a.query(`UPDATE sales SET tracking_status = 'tracked' WHERE id = $1`, [SALE_A_X]);
  const maps = await a.query<{ id: string; tenant_product_id: string }>(
    `INSERT INTO erpnext_item_map (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
                                   suggestion_source, confirmed_by, confirmed_at)
     VALUES (gen_random_uuid(), $1, $2, 'ITEM-NONE', 'confirmed', 'manual', $4, now()),
            (gen_random_uuid(), $1, $3, 'ITEM-BATCH', 'confirmed', 'manual', $4, now())
     RETURNING id, tenant_product_id`,
    [TENANT_A, P_NONE, P_BATCH, ACTOR_A],
  );
  itemMapNone = maps.rows.find((m) => m.tenant_product_id === P_NONE)!.id;
  itemMapBatch = maps.rows.find((m) => m.tenant_product_id === P_BATCH)!.id;
  const wh = await a.query<{ id: string }>(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'WH-S6', $3, 1) RETURNING id`,
    [TENANT_A, STORE_A_X, ACTOR_A],
  );
  warehouseMap = wh.rows[0]!.id;

  const contract = loadOpenApiContracts({
    dir: resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "erpnext-connector"),
  }).find((c) => c.id === "posting-feed");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract!.document as object), $id: "posting-feed" });
  validateWorkItem = ajv.compile({ $ref: "posting-feed#/components/schemas/PostingWorkItem" });
}, 240_000);

afterAll(async () => {
  delete process.env[GATE];
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(() => {
  delete process.env[GATE];
});

/** Tracking columns of one frozen line; undefined columns stay NULL (a version written before 0095). */
interface LineTracking {
  readonly mode?: string;
  readonly identity?: string;
  readonly batch?: string;
  readonly hold?: string;
}

let version = 1;

/** Freeze resolution v(n+1) with `untracked` / `tracked` tracking and point the intent at it. */
async function freeze(untracked: LineTracking, tracked: LineTracking): Promise<void> {
  version += 1;
  const a = pg().admin;
  for (const [line, map, item, t] of [
    [untrackedLine, itemMapNone, "ITEM-NONE", untracked],
    [trackedLine, itemMapBatch, "ITEM-BATCH", tracked],
  ] as const) {
    await a.query(
      `INSERT INTO erpnext_posting_resolution
         (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id,
          warehouse_ref, warehouse_map_id, resolved_by,
          tracking_mode, tracking_identity_id, erpnext_batch_ref, erp_hold_cause)
       VALUES ($1, $2, $3, $4, $5, $6, 'WH-S6', $7, 'system', $8, $9, $10, $11)`,
      [TENANT_A, POST_A_PENDING, version, line, item, map, warehouseMap,
       t.mode ?? null, t.identity ?? null, t.batch ?? null, t.hold ?? null],
    );
  }
  await a.query(
    `UPDATE erpnext_posting_status SET current_resolution_version = $2, sequence = DEFAULT WHERE id = $1`,
    [POST_A_PENDING, version],
  );
}

/** Tracked selling in effect for tenant A: the deploy gate AND the tenant switch. */
async function trackedSelling(gate: boolean, tenant: boolean): Promise<void> {
  if (gate) process.env[GATE] = "true";
  else delete process.env[GATE];
  await pg().admin.query(
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by, tracked_selling_enabled,
                                            tracked_selling_changed_at, tracked_selling_changed_by)
     VALUES ($1, $2, $3, now(), $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET tracked_selling_enabled = $3, tracked_selling_changed_at = now(), tracked_selling_changed_by = $2`,
    [TENANT_A, ACTOR_A, tenant],
  );
}

/** The pending sale_post's work item as the feed offers it, or null when it is held. */
async function offered(): Promise<PostingWorkItem | null> {
  const page = await new ErpnextPostingService(pg().app).pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
  return page.items.find((i) => i.workItemRef === POST_A_PENDING) ?? null;
}

function line(item: PostingWorkItem, ref: string): WorkItemLine {
  return item.sale.lines.find((l) => l.lineRef === ref)!;
}

const NONE: LineTracking = { mode: "none" };
const TRACKED: LineTracking = { mode: "batch", identity: I_A, batch: "BATCH-S6-A" };

describe("RT-451 S6: tracked selling not in effect", () => {
  it.each([
    ["the deploy gate is off", false, true],
    ["the tenant switch is off", true, false],
  ])("holds an intent with a tracked line when %s", async (_label, gate, tenant) => {
    if (skip) return;
    await trackedSelling(gate, tenant);
    await freeze(NONE, TRACKED);
    expect(await offered()).toBeNull();
  });

  it("offers an untracked intent with no tracking field at all (the wire before S6)", async () => {
    if (skip) return;
    await trackedSelling(false, false);
    await freeze(NONE, { mode: "batch" });
    const item = await offered();
    expect(item).not.toBeNull();
    for (const l of item!.sale.lines) {
      expect(Object.keys(l)).not.toContain("trackingMode");
      expect(Object.keys(l)).not.toContain("erpnextBatchRef");
    }
  });
});

describe("RT-451 S6: tracked selling in effect", () => {
  it("a tracked line emits batch and its frozen Batch; an untracked line emits none and null; the item matches the contract", async () => {
    if (skip) return;
    await trackedSelling(true, true);
    await freeze(NONE, TRACKED);
    const item = await offered();
    expect(item).not.toBeNull();
    expect(line(item!, trackedLine)).toMatchObject({
      erpnextItemRef: { doctype: "Item", name: "ITEM-BATCH" },
      trackingMode: "batch",
      erpnextBatchRef: { doctype: "Batch", name: "BATCH-S6-A" },
    });
    expect(line(item!, untrackedLine)).toMatchObject({ trackingMode: "none", erpnextBatchRef: null });
    const valid = validateWorkItem(JSON.parse(JSON.stringify(item)));
    expect(validateWorkItem.errors ?? null).toBeNull();
    expect(valid).toBe(true);
  });

  it.each<[string, LineTracking]>([
    ["edge_map_missing", { mode: "batch", identity: I_A, hold: "edge_map_missing" }],
    ["expired (with its Batch)", { mode: "batch", identity: I_A, batch: "BATCH-S6-A", hold: "expired" }],
  ])("never offers an intent held as %s", async (_label, held) => {
    if (skip) return;
    await trackedSelling(true, true);
    await freeze(NONE, held);
    expect(await offered()).toBeNull();
  });

  it("a batch line with no identity (switched off at capture) emits no tracking field", async () => {
    if (skip) return;
    await trackedSelling(true, true);
    await freeze(NONE, { mode: "batch" });
    const item = await offered();
    expect(item).not.toBeNull();
    expect(Object.keys(line(item!, trackedLine))).not.toContain("trackingMode");
    expect(Object.keys(line(item!, trackedLine))).not.toContain("erpnextBatchRef");
    expect(line(item!, untrackedLine)).toMatchObject({ trackingMode: "none", erpnextBatchRef: null });
  });

  it("a version frozen before 0095 emits no tracking field on lines capture never classified", async () => {
    if (skip) return;
    await trackedSelling(true, true);
    await pg().admin.query(`UPDATE sale_lines SET tracking_class = NULL WHERE id = $1`, [trackedLine]);
    try {
      await freeze({}, {});
      const item = await offered();
      expect(item).not.toBeNull();
      for (const l of item!.sale.lines) expect(Object.keys(l)).not.toContain("trackingMode");
    } finally {
      await pg().admin.query(`UPDATE sale_lines SET tracking_class = 'flagged' WHERE id = $1`, [trackedLine]);
    }
  });

  it.each([
    ["in effect", true],
    ["not in effect", false],
  ])("holds a classified tracked line whose version froze no tracking (%s)", async (_label, on) => {
    if (skip) return;
    await trackedSelling(on, on);
    await freeze({}, {});
    expect(await offered()).toBeNull();
  });

  it("the projection refuses to build a held tracked line (never offered without its Batch)", async () => {
    if (skip) return;
    await freeze(NONE, { mode: "batch", identity: I_A, hold: "edge_map_missing" });
    const build = runWithTenantContext(pg().app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (client) => {
      const row = await client.query<{ sequence: string; payload_hash: string }>(
        `SELECT sequence::text AS sequence, payload_hash FROM erpnext_posting_status WHERE id = $1`,
        [POST_A_PENDING],
      );
      return buildWorkItem(
        client,
        {
          id: POST_A_PENDING,
          kind: "sale_post",
          saleId: SALE_A_X,
          sourceRefId: SALE_A_X,
          sourceSystem: "pos",
          externalId: "sale-A-X",
          payloadHash: row.rows[0]!.payload_hash,
          sequence: row.rows[0]!.sequence,
          currentResolutionVersion: version,
        },
        true,
      );
    });
    await expect(build).rejects.toBeInstanceOf(TrackedLineNotPostableError);
  });
});

describe("RT-451 S6: operator re-resolution of a held intent (the real endpoint service)", () => {
  function reResolve(): ReturnType<ErpnextPostingReResolutionService["reResolvePosting"]> {
    return new ErpnextPostingReResolutionService(pg().app, new MembershipRepository(pg().app)).reResolvePosting({
      tenantId: TENANT_A,
      context: {
        userId: ACTOR_A,
        tenantId: TENANT_A,
        storeId: null,
        isPlatformAdmin: false,
        source: "session",
        storeAccess: { kind: "all" },
      },
      actorUserId: ACTOR_A,
      workItemRef: POST_A_PENDING,
    });
  }

  /** The tracked line's Batch and hold in the intent's current version. */
  async function current(): Promise<{ batch: string | null; hold: string | null }> {
    const r = await pg().admin.query<{ erpnext_batch_ref: string | null; erp_hold_cause: string | null }>(
      `SELECT r.erpnext_batch_ref, r.erp_hold_cause
         FROM erpnext_posting_status s
         JOIN erpnext_posting_resolution r
           ON r.intent_id = s.id AND r.resolution_version = s.current_resolution_version
        WHERE s.id = $1 AND r.sale_line_id = $2`,
      [POST_A_PENDING, trackedLine],
    );
    return { batch: r.rows[0]!.erpnext_batch_ref, hold: r.rows[0]!.erp_hold_cause };
  }

  it("is refused as unchanged without an edge-map row, and releases the hold once the edge map is repaired", async () => {
    if (skip) return;
    await trackedSelling(true, true);
    await freeze(NONE, { mode: "batch", identity: I_A, hold: "edge_map_missing" });
    await expect(reResolve()).rejects.toBeInstanceOf(ReResolveConflictError);
    expect(await current()).toEqual({ batch: null, hold: "edge_map_missing" });
    expect(await offered()).toBeNull();

    await pg().admin.query(
      `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref) VALUES ($1, $2, 'batch', 'BATCH-S6-A')`,
      [TENANT_A, I_A],
    );
    const recorded = await reResolve();
    version = recorded.resolutionVersion;
    expect(await current()).toEqual({ batch: "BATCH-S6-A", hold: null });
    const item = await offered();
    expect(item).not.toBeNull();
    expect(line(item!, trackedLine).erpnextBatchRef).toEqual({ doctype: "Batch", name: "BATCH-S6-A" });
  });

  it("keeps an expired lot held: a re-resolution never releases it (it goes to the owner, RT-50 B1)", async () => {
    if (skip) return;
    await trackedSelling(true, true);
    await pg().admin.query(
      `INSERT INTO sale_line_findings (tenant_id, store_id, sale_id, sale_line_id, tenant_product_ref,
                                       tracking_identity_id, kind, cause, business_date, occurred_at)
       SELECT s.tenant_id, s.store_id, s.id, $2, $3, $4, 'erp_intent_held', 'expired', s.business_date, s.occurred_at
         FROM sales s WHERE s.id = $1`,
      [SALE_A_X, trackedLine, P_BATCH, I_A],
    );
    version = (await reResolve()).resolutionVersion;
    expect(await current()).toEqual({ batch: "BATCH-S6-A", hold: "expired" });
    expect(await offered()).toBeNull();
    await expect(reResolve()).rejects.toBeInstanceOf(ReResolveConflictError);
    await pg().admin.query(`DELETE FROM sale_line_findings WHERE sale_line_id = $1`, [trackedLine]);
  });
});

describe("RT-451 S6: switching tracked selling on re-heads the held tracked intents", () => {
  const allMet = { unmet: () => Promise.resolve([]) } as unknown as TrackedSellingPreconditions;
  const setting = (): TrackedSellingSettingService =>
    new TrackedSellingSettingService(pg().app, new MembershipRepository(pg().app), allMet);

  it("a Connector whose cursor moved past a held intent is offered it after the switch-on", async () => {
    if (skip) return;
    await trackedSelling(true, false);
    await freeze(NONE, TRACKED);
    expect(await offered()).toBeNull();
    // The Connector's cursor has moved past every row of the tenant.
    const max = await pg().admin.query<{ s: string }>(
      `SELECT max(sequence)::text AS s FROM erpnext_posting_status WHERE tenant_id = $1`,
      [TENANT_A],
    );
    const since = BigInt(max.rows[0]!.s);
    const pull = () => new ErpnextPostingService(pg().app).pullPostings({ tenantId: TENANT_A, since, limit: 100 });
    expect((await pull()).items.map((i) => i.workItemRef)).not.toContain(POST_A_PENDING);

    await setting().setSetting({ tenantId: TENANT_A, userId: ACTOR_A, isPlatformAdmin: false }, true);
    const item = (await pull()).items.find((i) => i.workItemRef === POST_A_PENDING);
    expect(item).toBeDefined();
    expect(line(item!, trackedLine).erpnextBatchRef).toEqual({ doctype: "Batch", name: "BATCH-S6-A" });
  });
});

// Last: it adds a reversal to sale A-X, after which the sale can no longer be re-resolved.
describe("RT-451 S6: a reversal mirrors what its sale posted", () => {
  it("a reversal copying a version frozen before 0095 is offered, not held (its sale posted without a Batch)", async () => {
    if (skip) return;
    await trackedSelling(false, false);
    const a = pg().admin;
    const voidId = "01960000-0000-7000-8000-0000000b5021";
    const reversalId = "01960000-0000-7000-8000-0000000b5022";
    await a.query(
      `INSERT INTO sale_voids (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
       SELECT $1, s.id, s.tenant_id, s.store_id, s.business_date, s.source_system, 'void-s6', s.payload_hash, $2
         FROM sales s WHERE s.id = $3`,
      [voidId, ACTOR_A, SALE_A_X],
    );
    await a.query(
      `INSERT INTO erpnext_posting_status (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system,
                                           external_id, payload_hash, status, current_resolution_version)
       SELECT $1, s.tenant_id, s.store_id, s.id, 'reversal', $2, s.source_system, 'void-s6', s.payload_hash, 'pending', 1
         FROM sales s WHERE s.id = $3`,
      [reversalId, voidId, SALE_A_X],
    );
    // Its lineage copy of a sale_post version frozen before 0095: no tracking on the classified line.
    await a.query(
      `INSERT INTO erpnext_posting_resolution
         (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id,
          warehouse_ref, warehouse_map_id, resolved_by)
       VALUES ($1, $2, 1, $3, 'ITEM-NONE', $5, 'WH-S6', $7, 'system'),
              ($1, $2, 1, $4, 'ITEM-BATCH', $6, 'WH-S6', $7, 'system')`,
      [TENANT_A, reversalId, untrackedLine, trackedLine, itemMapNone, itemMapBatch, warehouseMap],
    );
    const page = await new ErpnextPostingService(pg().app).pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(page.items.map((i) => i.workItemRef)).toContain(reversalId);
  });
});
