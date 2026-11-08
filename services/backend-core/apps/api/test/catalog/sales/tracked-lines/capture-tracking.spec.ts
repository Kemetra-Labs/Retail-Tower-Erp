/**
 * Jira RT-451 slice S3 — capture tracking over HTTP against real Postgres
 * (every migration including 0089, the NOBYPASSRLS `app_test` role on
 * PG_POOL), through the real SalesController / SalesService and the
 * idempotency interceptor (the shared capture harness).
 *
 * Captain decisions RT-451 comments 16262 and 16269; `pos-sales/sales.yaml`
 * 1.21.0-draft.
 *
 * What this proves:
 *   - OFF (the deployment gate, or the tenant switch; comment 16269): a
 *     tracked product's line, with or without `tracking`, is an ordinary
 *     line (no class, no finding, no tracking status) and is never refused;
 *     a sent `tracking` is stored as received and echoed (provenance), and
 *     stays in `payload_hash`; `safetyRevision` / `safetySyncedAt` are
 *     accepted, stored and echoed, and kept out of `payload_hash`;
 *   - ON, the G7-9 classification with its precedence:
 *       row 1 valid (no finding), row 2 `unvalidated_tracked_line`
 *       (`validation_missing`, `validation_mismatch` for a refused or another
 *       identity's validation) and `sold_under_hold` (`quality_hold`, with its
 *       hold, judged at `occurredAt`), row 3 `erp_intent_held` (`expired` at
 *       the business date, inclusive; no expiry on an `expiry_required`
 *       product; `edge_map_missing`), several causes on one line, and row 4
 *       (`tracking_missing`, `identity_unknown`, `identity_other_product`)
 *       which wins over every other row and writes no finding;
 *   - the line's tracking is frozen and echoed (`SaleLineTracking`), the
 *     sale's tracking status is stored;
 *   - `tracking` is part of `payload_hash`: a provenance replay with different
 *     tracking is 409, an identical one 200, and a sale captured ON still
 *     replays after the switch goes OFF;
 *   - the per-product capture/profile lock (comment 11790), both ways: a
 *     capture waits for an in-flight profile change and classifies against the
 *     profile it committed; a profile change waits for an in-flight capture
 *     and then sees its line (`locked`);
 *   - `tracking_activation_pending` is lifted only while tracked selling is on.
 */
import { randomUUID } from "node:crypto";

import {
  captureBody,
  idempKey,
  resetHarness,
  startCaptureHarness,
  stopCaptureHarness,
  HARNESS_DEVICE_ID,
  TENANT_A,
  STORE_A_X,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { TRACKED_SELLING_GATE } from "../../../../src/catalog/sales/tracked-lines/tracked-selling-gate";
import { lockProductProfiles } from "../../../../src/catalog/sales/tracked-lines/capture-tracking";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import { TrackingProfileService } from "../../../../src/catalog/tracking-profile/tracking-profile.service";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const skip = (): boolean => h.dockerSkipped || !h.harness;
const admin = () => h.harness!.env.admin;

const id = (n: string): string => `0a451300-0000-4000-8000-0000000${n}`;
const ACTOR = id("000c1");
const P_BATCH = id("00f01"); // batch, expiry required
const P_BATCH_2 = id("00f02"); // batch, no expiry required
const P_PLAIN = id("00f03"); // not tracked
const P_LATE = id("00f04"); // none; its profile changes during a capture
const P_FRESH = id("00f05"); // none, no history: the setter's lift
const P_RACE = id("00f06"); // none, no history: a capture commits during a profile change
const I_OK = id("00a01"); // P_BATCH, expires 2026-05-01 (the business date: still sellable), edge map
const I_EXPIRED = id("00a02"); // P_BATCH, expired 2026-04-30, edge map
const I_NO_EDGE = id("00a03"); // P_BATCH, 2027-12-31, no edge map
const I_HELD = id("00a04"); // P_BATCH, quality hold placed before occurredAt, edge map
const I_LATE_HOLD = id("00a05"); // P_BATCH, quality hold placed AFTER occurredAt, edge map
const I_NO_EXPIRY = id("00a06"); // P_BATCH (expiry required), no expiry, edge map
const I_OTHER = id("00a07"); // P_BATCH_2, 2027-12-31, edge map
const I_LATE = id("00a08"); // P_LATE, no expiry, edge map
const HOLD = id("00b01");
const V_OK = id("00d01"); // accepted for I_OK at STORE_A_X
const V_REFUSED = id("00d02"); // refused for I_OK
const V_OTHER_IDENTITY = id("00d03"); // accepted for I_OTHER
const OCCURRED_AT = "2026-05-01T10:00:00.000Z"; // UTC store: business date 2026-05-01

let seq = 0;
const ext = (label: string): string => `s3-${label}-${++seq}`;

function trackedLine(product: string, tracking?: Record<string, unknown>): Record<string, unknown> {
  return {
    lineName: "Panadol",
    unitPrice: "5.0000",
    currencyCode: "USD",
    quantity: "1",
    lineAmount: "5.0000",
    unit: "box",
    tenantProductRef: product,
    ...(tracking === undefined ? {} : { tracking }),
  };
}

const tracking = (identityId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  identityId,
  code: "LOT",
  selection: "scanned",
  ...extra,
});

function body(label: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return captureBody({
    externalId: ext(label),
    occurredAt: OCCURRED_AT,
    posTotal: (lines.length * 5).toFixed(4),
    lines,
    ...extra,
  });
}

function post(b: Record<string, unknown>, key = randomUUID()) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key.replace(/-/g, ""))).send(b);
}

async function tenantSwitch(on: boolean): Promise<void> {
  await admin().query(
    `INSERT INTO tenant_inventory_settings
       (tenant_id, updated_by, tracked_selling_enabled, tracked_selling_changed_at, tracked_selling_changed_by)
     VALUES ($1, $2, $3, now(), $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET tracked_selling_enabled = $3, tracked_selling_changed_at = now(), tracked_selling_changed_by = $2`,
    [TENANT_A, ACTOR, on],
  );
}

async function on(): Promise<void> {
  process.env[TRACKED_SELLING_GATE] = "true";
  await tenantSwitch(true);
}

interface StoredLine {
  tracking_identity_id: string | null;
  tracking_class: string | null;
  tracking_unresolved_reason: string | null;
}

async function stored(saleRef: string): Promise<{
  status: string | null;
  lines: StoredLine[];
  findings: Array<{ kind: string; cause: string; hold_id: string | null; tracking_identity_id: string; business_date: string }>;
}> {
  const sale = await admin().query<{ tracking_status: string | null }>(`SELECT tracking_status FROM sales WHERE id = $1`, [saleRef]);
  const lines = await admin().query<StoredLine>(
    `SELECT tracking_identity_id::text AS tracking_identity_id, tracking_class, tracking_unresolved_reason
       FROM sale_lines WHERE sale_id = $1 ORDER BY line_seq`,
    [saleRef],
  );
  const findings = await admin().query(
    `SELECT f.kind, f.cause, f.hold_id::text AS hold_id, f.tracking_identity_id::text AS tracking_identity_id,
            f.business_date::text AS business_date
       FROM sale_line_findings f JOIN sale_lines l ON l.id = f.sale_line_id
      WHERE f.sale_id = $1 ORDER BY l.line_seq, f.kind, f.cause`,
    [saleRef],
  );
  return { status: sale.rows[0]?.tracking_status ?? null, lines: lines.rows, findings: findings.rows };
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (skip()) return;
  const a = admin();
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode, expiry_required)
     VALUES ($1, $5, 'Batch expiry', 'standard', $6, $6, 'batch', true),
            ($2, $5, 'Batch', 'standard', $6, $6, 'batch', false),
            ($3, $5, 'Plain', 'standard', $6, $6, 'none', false),
            ($4, $5, 'Late', 'standard', $6, $6, 'none', false),
            ($7, $5, 'Fresh', 'standard', $6, $6, 'none', false),
            ($8, $5, 'Race', 'standard', $6, $6, 'none', false)`,
    [P_BATCH, P_BATCH_2, P_PLAIN, P_LATE, TENANT_A, ACTOR, P_FRESH, P_RACE],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date)
     VALUES ($1, $9, $10, 'batch', 'LOT-OK', '2026-05-01'), ($2, $9, $10, 'batch', 'LOT-EXP', '2026-04-30'),
            ($3, $9, $10, 'batch', 'LOT-NOEDGE', '2027-12-31'), ($4, $9, $10, 'batch', 'LOT-HELD', '2027-12-31'),
            ($5, $9, $10, 'batch', 'LOT-LATEHOLD', '2027-12-31'), ($6, $9, $10, 'batch', 'LOT-NOEXP', NULL),
            ($7, $9, $11, 'batch', 'LOT-OTHER', '2027-12-31'), ($8, $9, $12, 'batch', 'LOT-LATE', NULL)`,
    [I_OK, I_EXPIRED, I_NO_EDGE, I_HELD, I_LATE_HOLD, I_NO_EXPIRY, I_OTHER, I_LATE, TENANT_A, P_BATCH, P_BATCH_2, P_LATE],
  );
  await a.query(
    `INSERT INTO erpnext_tracking_map (tenant_id, tracking_identity_id, kind, erpnext_ref)
     SELECT $1, i, 'batch', 'BATCH-' || i::text FROM unnest($2::uuid[]) AS i`,
    [TENANT_A, [I_OK, I_EXPIRED, I_HELD, I_LATE_HOLD, I_NO_EXPIRY, I_OTHER, I_LATE]],
  );
  await a.query(
    `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, placed_by, placed_at)
     VALUES ($1, $2, $3, $5, 'quality_hold', 'supplier_notice', $6, '2026-05-01T09:00:00Z'),
            ($7, $2, $4, $5, 'quality_hold', 'supplier_notice', $6, '2026-05-01T11:00:00Z')`,
    [HOLD, TENANT_A, I_HELD, I_LATE_HOLD, P_BATCH, ACTOR, id("00b02")],
  );
  await a.query(
    `INSERT INTO tracked_line_validations
       (id, tenant_id, store_id, device_id, operator_user_id, auth_path, tenant_product_ref,
        requested_identity_id, resolved_identity_id, selection, quantity, draft_line_ref, outcome, refusal_reason, safety_revision)
     VALUES ($1, $4, $5, $6, $7, 'device', $8, $9, $9, 'scanned', 1, 'd1', 'accepted', NULL, 0),
            ($2, $4, $5, $6, $7, 'device', $8, $9, $9, 'scanned', 1, 'd2', 'refused', 'held', 0),
            ($3, $4, $5, $6, $7, 'device', $10, $11, $11, 'scanned', 1, 'd3', 'accepted', NULL, 0)`,
    [V_OK, V_REFUSED, V_OTHER_IDENTITY, TENANT_A, STORE_A_X, HARNESS_DEVICE_ID, ACTOR, P_BATCH, I_OK, P_BATCH_2, I_OTHER],
  );
}, 180_000);

afterAll(async () => {
  delete process.env[TRACKED_SELLING_GATE];
  await stopCaptureHarness(h);
}, 60_000);

beforeEach(async () => {
  resetHarness(h);
  delete process.env[TRACKED_SELLING_GATE];
  if (!skip()) await tenantSwitch(false);
});

// ---------------------------------------------------------------------------
// OFF
// ---------------------------------------------------------------------------

describe("RT-451 S3 — tracked selling OFF (OD-T4)", () => {
  it.each<[string, () => Promise<void>]>([
    ["the deployment gate is off", async () => tenantSwitch(true)],
    ["the tenant switch is off", async () => { process.env[TRACKED_SELLING_GATE] = "true"; }],
  ])("a line carrying tracking is accepted, stored as received and not classified when %s", async (_why, arrange) => {
    if (skip()) return;
    await arrange();
    // Held, expired-elsewhere or unknown: nothing is judged while off.
    const t1 = tracking(I_HELD, { code: "LOT-HELD", expiryDate: "2027-12-31", validationId: V_REFUSED });
    const t2 = tracking(randomUUID(), { selection: "operator_selected" });
    const b = body("offtrack", [trackedLine(P_BATCH, t1), trackedLine(P_BATCH_2, t2)]);
    const res = await post(b);
    expect(res.status).toBe(201);
    expect(res.body.lines[0].tracking).toEqual({ ...t1, validationId: V_REFUSED });
    expect(res.body.lines[1].tracking).toEqual({ ...t2, expiryDate: null, validationId: null });
    const s = await stored(res.body.saleRef);
    expect(s.status).toBeNull();
    expect(s.lines).toEqual([
      { tracking_identity_id: I_HELD, tracking_class: null, tracking_unresolved_reason: null },
      { tracking_identity_id: t2["identityId"], tracking_class: null, tracking_unresolved_reason: null },
    ]);
    expect(s.findings).toEqual([]);
    const row = await admin().query(`SELECT payload_hash FROM sales WHERE id = $1`, [res.body.saleRef]);
    expect(row.rows[0].payload_hash).toBe(sha256CanonicalHex(b));
  });

  it("a tracked product's line without tracking is an ordinary line", async () => {
    if (skip()) return;
    const res = await post(body("offplain", [trackedLine(P_BATCH), trackedLine(P_PLAIN)]));
    expect(res.status).toBe(201);
    expect(res.body.lines.every((l: Record<string, unknown>) => !("tracking" in l))).toBe(true);
    const s = await stored(res.body.saleRef);
    expect(s.status).toBeNull();
    expect(s.lines.map((l) => l.tracking_class)).toEqual([null, null]);
    expect(s.findings).toEqual([]);
  });

  it("accepts, stores and echoes the safety provenance, kept out of payload_hash", async () => {
    if (skip()) return;
    const b = body("safety", [trackedLine(P_PLAIN)], { safetyRevision: 7, safetySyncedAt: "2026-05-01T09:30:00.000Z" });
    const res = await post(b);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ safetyRevision: 7, safetySyncedAt: "2026-05-01T09:30:00.000Z" });
    const { safetyRevision: _r, safetySyncedAt: _s, ...hashed } = b;
    const row = await admin().query(`SELECT payload_hash, safety_revision::int AS r FROM sales WHERE id = $1`, [res.body.saleRef]);
    expect(row.rows[0]).toEqual({ payload_hash: sha256CanonicalHex(hashed), r: 7 });
    // A provenance replay with other safety values is the same sale, never rewritten.
    const again = await post({ ...b, safetyRevision: 9 });
    expect(again.status).toBe(200);
    expect(again.body.safetyRevision).toBe(7);
  });

  it("a sale without them echoes null safety fields", async () => {
    if (skip()) return;
    const res = await post(body("nosafety", [trackedLine(P_PLAIN)]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ safetyRevision: null, safetySyncedAt: null });
  });
});

// ---------------------------------------------------------------------------
// ON: G7-9
// ---------------------------------------------------------------------------

describe("RT-451 S3 — tracked selling ON: the G7-9 classification", () => {
  it("row 1: a validated, unheld lot on its expiry date with an edge map is valid, with no finding", async () => {
    if (skip()) return;
    await on();
    const t = tracking(I_OK, { code: "LOT-OK", expiryDate: "2026-05-01", selection: "fefo_suggested", validationId: V_OK });
    const res = await post(body("row1", [trackedLine(P_BATCH, t), trackedLine(P_PLAIN)]));
    expect(res.status).toBe(201);
    expect(res.body.lines[0].tracking).toEqual({
      identityId: I_OK,
      code: "LOT-OK",
      expiryDate: "2026-05-01",
      selection: "fefo_suggested",
      validationId: V_OK,
    });
    expect("tracking" in res.body.lines[1]).toBe(false);
    const s = await stored(res.body.saleRef);
    expect(s.status).toBe("tracked");
    expect(s.lines.map((l) => l.tracking_class)).toEqual(["valid", null]);
    expect(s.findings).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, Array<[string, string]>]>([
    ["no validationId", tracking(I_OK), [["unvalidated_tracked_line", "validation_missing"]]],
    ["a refused validation", tracking(I_OK, { validationId: V_REFUSED }), [["unvalidated_tracked_line", "validation_mismatch"]]],
    ["another identity's validation", tracking(I_OK, { validationId: V_OTHER_IDENTITY }), [["unvalidated_tracked_line", "validation_mismatch"]]],
    ["an unknown validation", tracking(I_OK, { validationId: randomUUID() }), [["unvalidated_tracked_line", "validation_mismatch"]]],
    ["an expired lot", tracking(I_EXPIRED, { validationId: V_OK }), [
      ["erp_intent_held", "expired"],
      ["unvalidated_tracked_line", "validation_mismatch"],
    ]],
    ["no expiry on an expiry-required product", tracking(I_NO_EXPIRY), [
      ["erp_intent_held", "expired"],
      ["unvalidated_tracked_line", "validation_missing"],
    ]],
    ["no edge-map row", tracking(I_NO_EDGE), [
      ["erp_intent_held", "edge_map_missing"],
      ["unvalidated_tracked_line", "validation_missing"],
    ]],
  ])("rows 2 and 3: %s is flagged with its findings", async (_why, t, expected) => {
    if (skip()) return;
    await on();
    const res = await post(body("flag", [trackedLine(P_BATCH, t)]));
    expect(res.status).toBe(201);
    const s = await stored(res.body.saleRef);
    expect(s.status).toBe("tracked");
    expect(s.lines.map((l) => l.tracking_class)).toEqual(["flagged"]);
    expect(s.findings.map((f) => [f.kind, f.cause])).toEqual(expected);
    expect(s.findings.every((f) => f.business_date === "2026-05-01")).toBe(true);
  });

  it("row 2: a lot held at occurredAt is sold_under_hold with its hold; a hold placed later is not", async () => {
    if (skip()) return;
    await on();
    const res = await post(body("held", [trackedLine(P_BATCH, tracking(I_HELD)), trackedLine(P_BATCH, tracking(I_LATE_HOLD))]));
    expect(res.status).toBe(201);
    const s = await stored(res.body.saleRef);
    expect(s.findings.map((f) => [f.tracking_identity_id, f.kind, f.cause, f.hold_id])).toEqual([
      [I_HELD, "sold_under_hold", "quality_hold", HOLD],
      [I_HELD, "unvalidated_tracked_line", "validation_missing", null],
      [I_LATE_HOLD, "unvalidated_tracked_line", "validation_missing", null],
    ]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a tracked product's line without tracking", trackedLine(P_BATCH), "tracking_missing"],
    ["an unknown identity", trackedLine(P_BATCH, tracking(randomUUID())), "identity_unknown"],
    ["another product's identity", trackedLine(P_BATCH, tracking(I_OTHER, { validationId: V_OTHER_IDENTITY })), "identity_other_product"],
    ["an ad-hoc line with tracking", { ...trackedLine(P_BATCH, tracking(I_OK)), tenantProductRef: undefined }, "identity_other_product"],
  ])("row 4: %s makes the sale tracking_unresolved, with no finding", async (_why, line, reason) => {
    if (skip()) return;
    await on();
    // A row-1 line and a row-2 line beside it: row 4 is the sale's status, and
    // only the row-2 line records a finding.
    const res = await post(
      body("row4", [line, trackedLine(P_BATCH, tracking(I_OK, { validationId: V_OK })), trackedLine(P_BATCH, tracking(I_HELD))]),
    );
    expect(res.status).toBe(201);
    const s = await stored(res.body.saleRef);
    expect(s.status).toBe("tracking_unresolved");
    expect(s.lines.map((l) => [l.tracking_class, l.tracking_unresolved_reason])).toEqual([
      ["unresolved", reason],
      ["valid", null],
      ["flagged", null],
    ]);
    expect(s.findings.map((f) => f.tracking_identity_id)).toEqual([I_HELD, I_HELD]);
  });

  it("row 4 wins over a hold: another product's held identity records no finding", async () => {
    if (skip()) return;
    await on();
    const res = await post(body("prec", [trackedLine(P_BATCH_2, tracking(I_HELD))]));
    const s = await stored(res.body.saleRef);
    expect(s.lines[0]).toMatchObject({ tracking_class: "unresolved", tracking_unresolved_reason: "identity_other_product" });
    expect(s.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hash and replay
// ---------------------------------------------------------------------------

describe("RT-451 S3 — tracking in payload_hash", () => {
  it("an identical replay is 200; a replay with different tracking is 409 and writes nothing", async () => {
    if (skip()) return;
    await on();
    const b = body("hash", [trackedLine(P_BATCH, tracking(I_OK, { validationId: V_OK }))]);
    const first = await post(b);
    expect(first.status).toBe(201);
    const row = await admin().query(`SELECT payload_hash FROM sales WHERE id = $1`, [first.body.saleRef]);
    expect(row.rows[0].payload_hash).toBe(sha256CanonicalHex(b));
    expect((await post(b)).status).toBe(200);
    const other = { ...b, lines: [trackedLine(P_BATCH, tracking(I_EXPIRED, { validationId: V_OK }))] };
    const conflict = await post(other);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("idempotency_key_conflict");
    const n = await admin().query(`SELECT count(*)::int AS n FROM sale_line_findings WHERE sale_id = $1`, [first.body.saleRef]);
    expect(n.rows[0].n).toBe(0);
  });

  it("a sale captured ON still replays (200) after the switch goes OFF", async () => {
    if (skip()) return;
    await on();
    const b = body("replayoff", [trackedLine(P_BATCH, tracking(I_OK, { validationId: V_OK }))]);
    expect((await post(b)).status).toBe(201);
    await tenantSwitch(false);
    const again = await post(b);
    expect(again.status).toBe(200);
    expect(again.body.lines[0].tracking.identityId).toBe(I_OK);
  });
});

// ---------------------------------------------------------------------------
// Capture / profile lock (comment 11790)
// ---------------------------------------------------------------------------

describe("RT-451 S3 — the per-product capture/profile lock", () => {
  it("a capture waits for an in-flight profile change and classifies against the committed profile", async () => {
    if (skip()) return;
    await on();
    const client = await admin().connect();
    try {
      await client.query("BEGIN");
      await lockProductProfiles(client, TENANT_A, [P_LATE], "exclusive");
      await client.query(`UPDATE tenant_products SET tracking_mode = 'batch' WHERE id = $1`, [P_LATE]);
      // The capture blocks on the product's key until the change commits
      // (`.then` starts the request now: supertest is lazy until awaited).
      const pending = post(body("lock", [trackedLine(P_LATE)])).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      const before = await admin().query(`SELECT count(*)::int AS n FROM sale_lines WHERE tenant_product_ref = $1`, [P_LATE]);
      expect(before.rows[0].n).toBe(0);
      await client.query("COMMIT");
      const res = await pending;
      expect(res.status).toBe(201);
      const s = await stored(res.body.saleRef);
      expect(s.lines[0]).toMatchObject({ tracking_class: "unresolved", tracking_unresolved_reason: "tracking_missing" });
    } finally {
      client.release();
    }
  });
});

describe("RT-451 S3 — the Tracking Profile setter", () => {
  const setter = () => new TrackingProfileService(h.harness!.env.app);
  const setBatch = (productId: string) =>
    setter().set({ tenantId: TENANT_A, productId, trackingMode: "batch", expiryRequired: false, actorUserId: ACTOR });

  it("keeps tracking_activation_pending while tracked selling is off (gate or switch)", async () => {
    if (skip()) return;
    expect(await setBatch(P_FRESH)).toEqual({ kind: "activation_pending" });
    process.env[TRACKED_SELLING_GATE] = "true";
    expect(await setBatch(P_FRESH)).toEqual({ kind: "activation_pending" });
    await tenantSwitch(true);
    delete process.env[TRACKED_SELLING_GATE];
    expect(await setBatch(P_FRESH)).toEqual({ kind: "activation_pending" });
  });

  it("lifts it while tracked selling is on", async () => {
    if (skip()) return;
    await on();
    const res = await setBatch(P_FRESH);
    expect(res).toMatchObject({ kind: "ok", row: { productId: P_FRESH, trackingMode: "batch", profileLocked: false } });
  });

  it("a profile change waits for an in-flight capture, then sees its line and is locked", async () => {
    if (skip()) return;
    await on();
    const sale = await post(body("race", [trackedLine(P_PLAIN)]));
    expect(sale.status).toBe(201);
    const client = await admin().connect();
    try {
      await client.query("BEGIN");
      await lockProductProfiles(client, TENANT_A, [P_RACE], "shared");
      await client.query(
        `INSERT INTO sale_lines (sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                                 line_amount, unit, tenant_product_ref)
         VALUES ($1, $2, $3, 'Race', 1, 'USD', 1, 1, 'ea', $4)`,
        [sale.body.saleRef, TENANT_A, STORE_A_X, P_RACE],
      );
      let settled = false;
      const pending = setBatch(P_RACE).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await client.query("COMMIT");
      expect(await pending).toEqual({ kind: "locked" });
    } finally {
      client.release();
    }
    const mode = await admin().query(`SELECT tracking_mode FROM tenant_products WHERE id = $1`, [P_RACE]);
    expect(mode.rows[0].tracking_mode).toBe("none");
  });
});
