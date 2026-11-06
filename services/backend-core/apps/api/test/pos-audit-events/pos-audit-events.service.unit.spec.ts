jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: jest.fn() }),
  ),
}));

import "reflect-metadata";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import { LEGACY_SHIFT_OPEN_SQL, PosAuditEventsService } from "../../src/pos-audit-events/pos-audit-events.service";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { AuditEventItemInput, PosAuditEventsSyncInput } from "../../src/pos-audit-events/dto";

const TENANT_ID   = "11111111-0000-4000-8000-000000000001";
const STORE_ID    = "22222222-0000-4000-8000-000000000001";
const DEVICE_TOKEN = "valid-device-token";
const DEVICE_ID = "44444444-0000-4000-8000-000000000001";

function makeEvent(overrides: Partial<AuditEventItemInput> = {}): AuditEventItemInput {
  return {
    event_id:                "aaaaaaaa-0000-4000-8000-000000000001",
    tenant_id:               TENANT_ID,
    branch_id:               STORE_ID,
    originating_terminal_id: DEVICE_ID,
    acting_operator_id:      "user_clerk_test",
    action_category:         "shift.open",
    created_at:              "2026-01-15T10:00:00.000Z",
    payload:                 { shift_id: "55555555-0000-4000-8000-000000000001", opened_at: "2026-01-15T10:00:00.000Z" },
    ...overrides,
  };
}

function makeBody(events: AuditEventItemInput[] = [makeEvent()]): PosAuditEventsSyncInput {
  return {
    device_token_attestation: DEVICE_TOKEN,
    events,
  };
}

const fakeDevice = {
  id:        DEVICE_ID,
  tenantId:  TENANT_ID,
  storeId:   STORE_ID,
  label:     "till",
  tokenHash: "h",
  revokedAt: null,
  createdAt: new Date(),
};

let mockPool: { query: jest.Mock };
let mockLookupPool: { query: jest.Mock };
let fakeDeviceRepo: { findActiveByAttestation: jest.MockedFunction<DeviceRepository["findActiveByAttestation"]> };
let mockLogger: { warn: jest.MockedFunction<() => void>; info: jest.MockedFunction<() => void> };
let service: PosAuditEventsService;

beforeEach(() => {
  jest.clearAllMocks();

  mockPool      = { query: jest.fn() };
  mockLookupPool = { query: jest.fn() };
  fakeDeviceRepo = { findActiveByAttestation: jest.fn().mockResolvedValue(fakeDevice) };
  mockLogger    = { warn: jest.fn(), info: jest.fn() };

  service = new PosAuditEventsService(
    mockPool as unknown as Pool,
    fakeDeviceRepo as unknown as DeviceRepository,
    mockLogger as unknown as Logger,
    mockLookupPool as unknown as Pool,
  );

  (runWithTenantContext as jest.Mock).mockImplementation(
    async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
      const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      return fn(fakeClient);
    },
  );

  mockPool.query.mockResolvedValue({ rows: [{ id: "actor-user-id" }] });
  // identity links of the session users (RT-796): the lookup pool answers them.
  mockLookupPool.query.mockResolvedValue({ rows: [{ user_id: "actor-user-id" }] });
});

// ===========================================================================
// 1. Device not found → { kind: "device_invalid" }
// ===========================================================================

describe("syncBatch — device resolution", () => {
  it("D1: device not found → { kind: 'device_invalid' }", async () => {
    fakeDeviceRepo.findActiveByAttestation.mockResolvedValue(null);

    const result = await service.syncBatch(makeBody(), "req-id");

    expect(result).toEqual({ kind: "device_invalid" });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2-5. Structural validation rejections (schema_violation)
// ===========================================================================

describe("syncBatch — schema_violation rejections", () => {
  it("SV1: invalid action_category → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ action_category: "unknown.category" })]),
      "req-id",
    );

    expect(result).toMatchObject({
      accepted: [],
      rejected: [{ event_id: expect.any(String), category: "schema_violation" }],
    });
  });

  it("SV2: forbidden payload field (pin) → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ payload: { pin: "1234" } })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "schema_violation" }],
    });
  });

  it("SV3: shift.open with non-UUID payload.shift_id → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ payload: { shift_id: "not-a-uuid", opened_at: "2026-01-15T10:00:00.000Z" } })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "schema_violation" }],
    });
  });

  it("SV4: shift.open with missing payload.shift_id → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ payload: { opened_at: "2026-01-15T10:00:00.000Z" } })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "schema_violation" }],
    });
  });
});

// ===========================================================================
// 6-7. Tenant / branch scope mismatch → tenant_mismatch
// ===========================================================================

describe("syncBatch — tenant_mismatch rejections", () => {
  it("TM1: event.tenant_id !== device.tenantId → tenant_mismatch", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ tenant_id: "different-tenant-id" })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "tenant_mismatch" }],
    });
  });

  it("TM2: event.branch_id !== device.storeId → tenant_mismatch", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ branch_id: "different-store-id" })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "tenant_mismatch" }],
    });
  });
});

// ===========================================================================
// 8. Actor not found → invalid_input
// ===========================================================================

describe("syncBatch — actor resolution", () => {
  it("AR0: contradictory client terminal id is rejected before persistence", async () => {
    const result = await service.syncBatch(
      makeBody([
        makeEvent({
          originating_terminal_id: "44444444-0000-4000-8000-000000000099",
        }),
      ]),
      null,
    );

    expect(result).toMatchObject({ rejected: [{ category: "invalid_input" }] });
    expect(runWithTenantContext).not.toHaveBeenCalled();
  });

  it("AR1: actor lookup returns no rows → invalid_input", async () => {
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    );

    const result = await service.syncBatch(makeBody(), null);

    expect(result).toMatchObject({
      rejected: [{ category: "invalid_input" }],
    });
  });

  it("AR2: actor lookup binds tenant, store, device, session and event time", async () => {
    let actorSql = "";
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const query = jest.fn(async (sql: string) => {
          if (String(sql).includes("FROM auth_tokens token")) {
            actorSql = String(sql);
            return { rows: [{ user_id: "user-1" }] };
          }
          return { rows: [{ id: makeEvent().event_id }] };
        });
        return fn({ query });
      },
    );

    const result = await service.syncBatch(makeBody(), null);
    expect(result).toMatchObject({ accepted: [makeEvent().event_id] });
    expect(actorSql).toContain("token.device_id = $3");
    expect(actorSql).toContain("token.store_id = $2");
    expect(actorSql).toContain("token.issued_at <= $5::timestamptz");
    expect(actorSql).toContain("token.revoked_at IS NULL OR token.revoked_at >= $5::timestamptz");
    expect(actorSql).toContain("$4::uuid IS NULL OR token.id = $4::uuid");
  });

  it("AR3: the acting id is matched against ANY link of the session users, on the lookup pool", async () => {
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const query = jest.fn(async (sql: string) =>
          String(sql).includes("FROM auth_tokens token")
            ? { rows: [{ user_id: "user-1" }, { user_id: "user-2" }] }
            : { rows: [{ id: makeEvent().event_id }] },
        );
        return fn({ query });
      },
    );

    await service.syncBatch(makeBody(), null);

    const [sql, params] = mockLookupPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FROM external_identity_links");
    // any status, any provider: no status or provider_key predicate.
    expect(sql).not.toMatch(/status|provider_key/);
    expect(params).toEqual(["user_clerk_test", ["user-1", "user-2"]]);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("AR4: no session user holds a link with that subject → invalid_input, nothing inserted", async () => {
    mockLookupPool.query.mockResolvedValue({ rows: [] });
    const inserts: string[] = [];
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const query = jest.fn(async (sql: string) => {
          if (String(sql).includes("INSERT INTO audit_events")) inserts.push(String(sql));
          return { rows: [{ user_id: "user-1" }] };
        });
        return fn({ query });
      },
    );

    const result = await service.syncBatch(makeBody(), null);

    expect(result).toMatchObject({ accepted: [], rejected: [{ category: "invalid_input" }] });
    expect(inserts).toEqual([]);
  });
});

// ===========================================================================
// 9-10. Idempotent insert outcomes
// ===========================================================================

describe("syncBatch — accepted / duplicate outcomes", () => {
  it("IO1: accepted event → event_id in accepted array", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const fakeClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
        };
        return fn(fakeClient);
      },
    );

    const evt    = makeEvent();
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toMatchObject({
      accepted:  [evt.event_id],
      duplicates: [],
      rejected:  [],
    });
  });

  it("IO2: duplicate event (ON CONFLICT returns no rows) → event_id in duplicates array", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const fakeClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        return fn(fakeClient);
      },
    );

    const evt    = makeEvent();
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toMatchObject({
      accepted:   [],
      duplicates: [evt.event_id],
      rejected:   [],
    });
  });
});

// ===========================================================================
// 11-12. shift.open side-effect: shifts INSERT
// ===========================================================================

describe("syncBatch — shift.open side-effect", () => {
  it("SH1: shift.open accepted → actor validation + audit_events + device lifecycle lock + shifts", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    let capturedClient: { query: jest.Mock } | null = null;

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        capturedClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
        };
        return fn(capturedClient);
      },
    );

    await service.syncBatch(makeBody([makeEvent({ action_category: "shift.open" })]), "req-id");

    expect(capturedClient!.query).toHaveBeenCalledTimes(4);
    // RT-365: the device lifecycle lock is taken before the legacy shift row,
    // which is written only while the device is unrevoked.
    const statements = capturedClient!.query.mock.calls.map((call) => String(call[0]));
    expect(statements[2]).toContain("pg_advisory_xact_lock");
    expect(statements[3]).toBe(LEGACY_SHIFT_OPEN_SQL);
    expect(LEGACY_SHIFT_OPEN_SQL).toContain("d.revoked_at IS NULL");
  });

  it("SH1b: shift.open of a device revoked meanwhile → no shift row, one ids-only warning (RT-365)", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    let capturedClient: { query: jest.Mock } | null = null;

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        capturedClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ revoked: true }] }),
        };
        return fn(capturedClient);
      },
    );

    const result = await service.syncBatch(makeBody([makeEvent({ action_category: "shift.open" })]), "req-id");

    // The audit event itself is still accepted; only the legacy shift row is withheld.
    expect(result).toMatchObject({ accepted: [makeEvent().event_id] });
    expect(capturedClient!.query).toHaveBeenCalledTimes(5);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = mockLogger.warn.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(Object.keys(fields).sort()).toEqual(["device_id", "event_id", "request_id", "shift_id"]);
    expect(message).toMatch(/revoked device/);
  });

  it("SH2: shift.close accepted → actor validation + audit insert only", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    let capturedClient: { query: jest.Mock } | null = null;

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        capturedClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
        };
        return fn(capturedClient);
      },
    );

    await service.syncBatch(makeBody([makeEvent({ action_category: "shift.close" })]), "req-id");

    expect(capturedClient!.query).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 13. Unexpected error in processEvent → rejected as invalid_input
// ===========================================================================

describe("syncBatch — unexpected error isolation", () => {
  it("UE1: pool.query throws → event pushed to rejected as invalid_input; other events unaffected", async () => {
    (runWithTenantContext as jest.Mock).mockRejectedValue(new Error("DB connection reset"));

    const result = await service.syncBatch(makeBody([makeEvent()]), "req-id");

    expect(result).toMatchObject({
      rejected: [{ event_id: "aaaaaaaa-0000-4000-8000-000000000001", category: "invalid_input" }],
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 14. Mixed batch: accepted + rejected + duplicates
// ===========================================================================

describe("syncBatch — mixed batch", () => {
  it("MB1: mix of accepted, rejected, and duplicate in one call", async () => {
    const evtAccepted  = makeEvent({ event_id: "aaaaaaaa-0000-4000-8000-000000000001" });
    const evtRejected  = makeEvent({ event_id: "bbbbbbbb-0000-4000-8000-000000000002", action_category: "bad.cat" });
    const evtDuplicate = makeEvent({ event_id: "cccccccc-0000-4000-8000-000000000003" });

    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    // evtRejected short-circuits before runWithTenantContext, so only two
    // invocations occur: first for evtAccepted (accepted), second for evtDuplicate (duplicate).
    (runWithTenantContext as jest.Mock)
      .mockImplementationOnce(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
          const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [{ id: evtAccepted.event_id }] }) };
          return fn(fakeClient);
        },
      )
      .mockImplementationOnce(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
          const fakeClient = {
            query: jest.fn()
              .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
              .mockResolvedValueOnce({ rows: [] }),
          };
          return fn(fakeClient);
        },
      );

    const result = await service.syncBatch(makeBody([evtAccepted, evtRejected, evtDuplicate]), "req-id");

    expect(result).toMatchObject({
      accepted:   [evtAccepted.event_id],
      duplicates: [evtDuplicate.event_id],
      rejected:   [{ event_id: evtRejected.event_id, category: "schema_violation" }],
    });
  });
});

// ===========================================================================
// 15. All valid non-shift.open action categories are accepted
// ===========================================================================

describe("syncBatch — valid non-shift.open action categories", () => {
  const nonShiftOpenCategories = [
    "shift.close",
    "shift.forced_close",
    "operator.session.takeover",
    "cashier.pin.reset",
    "cashier.pin.unlock",
  ];

  for (const category of nonShiftOpenCategories) {
    it(`NC-${category}: action_category '${category}' accepted without schema_violation`, async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

      (runWithTenantContext as jest.Mock).mockImplementation(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
          const fakeClient = {
            query: jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
          };
          return fn(fakeClient);
        },
      );

      const evt    = makeEvent({ action_category: category });
      const result = await service.syncBatch(makeBody([evt]), "req-id");

      expect(result).toMatchObject({
        accepted: [evt.event_id],
        rejected: [],
      });
    });
  }
});

// ===========================================================================
// RT-740 DEP-2 — cart.discount.manager_authorized
// ===========================================================================

describe("syncBatch — RT-740 cart.discount.manager_authorized", () => {
  const discountPayload = {
    cart_id: "cart-1",
    cart_line_id: "line-1",
    placeholder_id: "pos-pulse:0195b200-0000-7000-8000-000000000740",
    reason_code: "promotion",
    kind: "percent",
    value: 10,
    amount_minor: 900,
  };

  it("DA1: a well-formed discount event is accepted and its payload stored as metadata", async () => {
    const insert = jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] });
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query: insert }),
    );
    insert.mockResolvedValueOnce({ rows: [{ id: "user-1" }] });

    const evt = makeEvent({
      action_category: "cart.discount.manager_authorized",
      approving_supervisor_id: "user_clerk_manager",
      payload: discountPayload,
    });
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toMatchObject({ accepted: [evt.event_id], rejected: [] });
    const auditInsert = insert.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_events"));
    expect(auditInsert?.[1]?.[6]).toBe("cart.discount.manager_authorized");
    expect(JSON.parse(auditInsert?.[1]?.[10] as string)).toEqual(discountPayload);
  });

  it.each([
    ["a free-text reason", { ...discountPayload, reason_code: "my neighbour" }],
    ["a reason note", { ...discountPayload, reason_note: "regular customer" }],
    ["a missing placeholder_id", { cart_id: "cart-1", cart_line_id: "line-1" }],
  ])("DA2: %s → schema_violation, nothing persisted", async (_name, payload) => {
    const evt = makeEvent({ action_category: "cart.discount.manager_authorized", payload });
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toMatchObject({ accepted: [], rejected: [{ event_id: evt.event_id, category: "schema_violation" }] });
    expect(runWithTenantContext).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// RT-1230 (RT-160 D-2) — the privileged, security and exception categories
// ===========================================================================

describe("syncBatch — RT-1230 privileged categories", () => {
  const ID = "0195b200-0000-7000-8000-000000001230";
  const AT = "2026-11-06T18:00:00.000Z";
  // The payload each POS emitter builds today (see privileged-audit-payloads.ts).
  const valid: Record<string, Record<string, unknown>> = {
    "manager_approval.granted": { approval_id: ID, action_kind: "sale.void", subject_ref: ID, reason_code: "wrong_item" },
    "manager_approval.refused": { action_kind: "sale.void", subject_ref: ID },
    "payment.recovery_completed": { payment_attempt_id: ID, cart_id: ID, approval_id: ID },
    "payment.recovery_cancelled": {
      payment_attempt_id: ID, cart_id: ID, approval_id: ID,
      cash_returned_confirmed: true, card_void_confirmed_on_terminal: true,
    },
    "cart.held_cancelled_by_manager": { cart_id: ID, approval_id: ID, kind: "draft", parked: true },
    "cart.cancel.post_handoff": { cart_id: ID, handoff_action_id: ID },
    "sale.receipt.manual_override": { sale_id: ID, print_event_id: ID },
    "sale.void.requested": {
      void_id: ID, sale_id: ID, amount_minor: 500, currency_code: "EGP", business_date: "2026-11-06",
      approval_id: ID, policy_version: "rt114-2026-10-07", approved_at: AT, requester_user_id: ID,
    },
    "payment.force_failed": {
      force_failed_at: AT, force_fail_attribution_operator_id: "user_clerk_manager",
      original_cashier_operator_id: "user_clerk_test",
    },
    "tender.reversed": {
      tender_line_id: ID, payment_attempt_id: ID, tender_type: "cash", reversed_at: AT,
      attribution_operator_id: "user_clerk_test", manual_void_required: false,
    },
    "tender.reversal_pending": {
      tender_line_id: ID, payment_attempt_id: ID, tender_type: "internal_voucher",
      reversal_pending_since: AT, attribution_operator_id: "user_clerk_test",
    },
  };

  it.each(Object.entries(valid))(
    "PV1 %s: a valid payload is accepted and stored verbatim under its own category",
    async (category, payload) => {
      const insert = jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] });
      (runWithTenantContext as jest.Mock).mockImplementation(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
          fn({ query: insert }),
      );
      insert.mockResolvedValueOnce({ rows: [{ user_id: "actor-user-id" }] });

      const evt = makeEvent({ action_category: category, approving_supervisor_id: "user_clerk_manager", payload });
      const result = await service.syncBatch(makeBody([evt]), "req-id");

      expect(result).toEqual({ accepted: [evt.event_id], duplicates: [], rejected: [] });
      const auditInsert = insert.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_events"));
      expect(auditInsert?.[1]?.[6]).toBe(category);
      expect(JSON.parse(auditInsert?.[1]?.[10] as string)).toEqual(payload);
      // Only shift.open writes a legacy row; no RT-1230 category has a side effect.
      expect(insert.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO shifts"))).toBe(false);
    },
  );

  it.each(Object.entries(valid))(
    "PV2 %s: an invalid payload (unknown key) is refused as schema_violation, nothing persisted",
    async (category, payload) => {
      const evt = makeEvent({ action_category: category, payload: { ...payload, note: "free text" } });
      const result = await service.syncBatch(makeBody([evt]), "req-id");

      expect(result).toEqual({
        accepted: [],
        duplicates: [],
        rejected: [{ event_id: evt.event_id, category: "schema_violation" }],
      });
      expect(runWithTenantContext).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a routine lock (D-2: local only)", "operator.session.locked"],
    ["a no-sale drawer action (not built yet)", "drawer.no_sale"],
    ["a reprint (not in this revision)", "sale.receipt.reprinted"],
  ])("PV3: %s is an unsupported category → schema_violation in the 200 body, nothing persisted", async (_n, category) => {
    const evt = makeEvent({ action_category: category, payload: {} });
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toEqual({
      accepted: [],
      duplicates: [],
      rejected: [{ event_id: evt.event_id, category: "schema_violation" }],
    });
    expect(runWithTenantContext).not.toHaveBeenCalled();
  });

  it.each(["2026-13-01", "2026-00-10", "2026-01-00"])(
    "PV5: an out-of-range business_date %s is schema_violation (never a thrown invalid_input)",
    async (businessDate) => {
      const evt = makeEvent({
        action_category: "sale.void.requested",
        payload: { ...valid["sale.void.requested"], business_date: businessDate },
      });
      const result = await service.syncBatch(makeBody([evt]), "req-id");

      expect(result).toEqual({
        accepted: [],
        duplicates: [],
        rejected: [{ event_id: evt.event_id, category: "schema_violation" }],
      });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    },
  );

  it("PV4: one invalid privileged event does not block a valid one in the same batch", async () => {
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue({ rows: [{ id: "x" }] }) }),
    );
    const good = makeEvent({ action_category: "payment.force_failed", payload: valid["payment.force_failed"] ?? {} });
    const bad = makeEvent({
      event_id: "aaaaaaaa-0000-4000-8000-000000000002",
      action_category: "sale.void.requested",
      payload: { ...valid["sale.void.requested"], amount_minor: -5 },
    });
    const result = await service.syncBatch(makeBody([bad, good]), "req-id");

    expect(result).toEqual({
      accepted: [good.event_id],
      duplicates: [],
      rejected: [{ event_id: bad.event_id, category: "schema_violation" }],
    });
  });
});
