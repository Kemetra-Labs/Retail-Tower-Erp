/**
 * RT-1061 (RT-977 slice 1, D1-D9) — `ConsoleSaleDetail.erpPostingFailure`:
 * the pure projection, the probe's keys and the disclosure / repair-handle
 * rules, plus the shared tenant role gate (`auth/tenant-role-gate.ts`) that
 * `RolesGuard` and the disclosure both use. No DB: the HTTP integration spec
 * (`console-sales.posting-failure.http.integration.spec.ts`) proves the same
 * rules against real Postgres and `repairPosting`.
 */
import type { PoolClient } from "pg";

import { decideTenantRoleGate, isSessionPlatformAdmin, type TenantRoleGateLookups } from "../../src/auth/tenant-role-gate";
import { POSTING_BACKLOG_ROLES } from "../../src/catalog/erpnext-reconciliation/posting-backlog-access";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";
import {
  hasFailedPosting,
  loadErpPostingFailure,
  POSTING_FAILURE_SQL,
  toErpPostingFailure,
  type PostingFailureRow,
} from "../../src/console-sales/console-sales.posting-failure";

const TENANT = "0a000000-0000-7000-8000-000000106111";
const STORE = "0a000000-0000-7000-8000-000000106112";
const SALE = "0a000000-0000-7000-8000-000000106113";
const USER = "0a000000-0000-7000-8000-000000106114";
const SALE_ITEM = "0a000000-0000-7000-8000-000000106121";
const REVERSAL_ITEM = "0a000000-0000-7000-8000-000000106122";
const REASON = "ValidationError: Item WIDGET-1 not found";

function deadLetter(kind: "sale_post" | "reversal", extra: Partial<PostingFailureRow> = {}): PostingFailureRow {
  return {
    id: kind === "sale_post" ? SALE_ITEM : REVERSAL_ITEM,
    kind,
    status: "permanently_rejected",
    rejection_category: "validation",
    sale_id: SALE,
    source_system: "pos",
    external_id: `ext-${kind}`,
    updated_at: new Date("2026-11-02T10:00:00Z"),
    reconciliation_document_ref: null,
    rejection_message: REASON,
    ...extra,
  };
}

describe("RT-1061 erpPostingFailure — projection", () => {
  it("full: the category, the time, the stored reason verbatim and the repair handle", () => {
    expect(toErpPostingFailure([deadLetter("sale_post")], "full", true)).toEqual({
      disclosure: "full",
      sale: {
        rejectionCategory: "validation",
        deadLetteredAt: "2026-11-02T10:00:00.000Z",
        reason: REASON,
        reconciliationDocumentRef: null,
        repair: { workItemRef: SALE_ITEM },
      },
      reversal: null,
    });
  });

  it("category_only: the category and the time; reason, evidence and repair are null whatever is stored", () => {
    const evidence = JSON.stringify({ doctype: "Sales Invoice", name: "SINV-9" });
    const out = toErpPostingFailure(
      [deadLetter("sale_post"), deadLetter("reversal", { rejection_category: "reconciliation_required", reconciliation_document_ref: evidence })],
      "category_only",
      true,
    );
    expect(out.disclosure).toBe("category_only");
    for (const side of [out.sale, out.reversal]) {
      expect(side).toMatchObject({ reason: null, reconciliationDocumentRef: null, repair: null });
      expect(side!.deadLetteredAt).toBe("2026-11-02T10:00:00.000Z");
    }
    expect(out.reversal!.rejectionCategory).toBe("reconciliation_required");
    expect(JSON.stringify(out)).not.toContain(REASON);
    expect(JSON.stringify(out)).not.toContain("SINV-9");
  });

  it("reconciliation_required is never offered for repair (RT-332); its evidence is shown under full", () => {
    const evidence = JSON.stringify({ doctype: "Sales Invoice", name: "SINV-9" });
    const out = toErpPostingFailure(
      [deadLetter("reversal", { rejection_category: "reconciliation_required", reconciliation_document_ref: evidence })],
      "full",
      true,
    );
    expect(out.reversal).toMatchObject({
      repair: null,
      reconciliationDocumentRef: { doctype: "Sales Invoice", name: "SINV-9" },
    });
    expect(out.sale).toBeNull();
  });

  it("a store the caller cannot write (deleted, or outside the membership scope) gets no handle", () => {
    expect(toErpPostingFailure([deadLetter("sale_post")], "full", false).sale).toMatchObject({ reason: REASON, repair: null });
  });

  it("a pre-0071 or Backend-Core-raised dead-letter has reason null; a null category is kept null", () => {
    const out = toErpPostingFailure([deadLetter("sale_post", { rejection_message: null, rejection_category: null })], "full", true);
    expect(out.sale).toMatchObject({ reason: null, rejectionCategory: null, repair: { workItemRef: SALE_ITEM } });
  });

  it("a row that is not dead-lettered is not a failure (a concurrent repair): the side is null", () => {
    expect(toErpPostingFailure([deadLetter("sale_post", { status: "pending" })], "full", true)).toEqual({
      disclosure: "full",
      sale: null,
      reversal: null,
    });
  });

  it("only a failed side triggers the probe", () => {
    expect(hasFailedPosting({ sale: "failed", saleDocumentRef: null, reversal: null, reversalDocumentRef: null })).toBe(true);
    expect(hasFailedPosting({ sale: "posted", saleDocumentRef: "S", reversal: "failed", reversalDocumentRef: null })).toBe(true);
    for (const sale of ["posted", "pending", "unknown"] as const) {
      expect(hasFailedPosting({ sale, saleDocumentRef: null, reversal: "pending", reversalDocumentRef: null })).toBe(false);
    }
  });
});

describe("RT-1061 erpPostingFailure — the probe", () => {
  const sql = POSTING_FAILURE_SQL.replace(/\s+/g, " ");

  it("is keyed exactly as the detail's joins, never by sale_id (no return / refund reason on the void side, D9)", () => {
    expect(sql).toContain("p.kind = 'sale_post' AND p.source_ref_id = $3::uuid");
    expect(sql).toContain("p.kind = 'reversal' AND p.source_ref_id = ( SELECT v.id FROM sale_voids v WHERE v.sale_id = $3::uuid");
    expect(sql).not.toMatch(/p\.sale_id\s*=/);
  });

  it("carries the tenant and an explicit store predicate, and reads only dead-letters", () => {
    expect(sql).toContain("p.tenant_id = $1::uuid AND p.store_id = $2::uuid");
    expect(sql).toContain("v.tenant_id = $1::uuid AND v.store_id = $2::uuid");
    expect(sql).toContain("p.status = 'permanently_rejected'");
  });
});

// ---------------------------------------------------------------------------
// The loader, with a fake client and membership repository
// ---------------------------------------------------------------------------

interface Fake {
  readonly client: PoolClient;
  readonly memberships: MembershipRepository;
  readonly queries: string[];
}

function fake(opts: { role: string | null; platformAdmin?: boolean; rows?: PostingFailureRow[]; storeLive?: boolean }): Fake {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text === POSTING_FAILURE_SQL) return { rows: opts.rows ?? [deadLetter("sale_post")] };
      if (/FROM stores/.test(text)) return { rows: opts.storeLive === false ? [] : [{ id: STORE }] };
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as PoolClient;
  const memberships = {
    findRoleCodeForUserInTenant: async () => opts.role,
    isPlatformAdmin: async () => opts.platformAdmin === true,
  } as unknown as MembershipRepository;
  return { client, memberships, queries };
}

function context(extra: Partial<ResolvedContext> = {}): ResolvedContext {
  return { userId: USER, tenantId: TENANT, storeId: null, isPlatformAdmin: false, source: "session", storeAccess: { kind: "all" }, ...extra };
}

const FAILED = { sale: "failed", saleDocumentRef: null, reversal: null, reversalDocumentRef: null } as const;
const POSTED = { sale: "posted", saleDocumentRef: "S", reversal: null, reversalDocumentRef: null } as const;

describe("RT-1061 erpPostingFailure — loader", () => {
  const input = (ctx: ResolvedContext, erpPosting: typeof FAILED | typeof POSTED = FAILED) => ({
    tenantId: TENANT,
    context: ctx,
    storeId: STORE,
    saleRef: SALE,
    erpPosting,
  });

  it("does not query anything when no side failed, and returns null", async () => {
    const f = fake({ role: "owner" });
    expect(await loadErpPostingFailure(f.client, f.memberships, input(context(), POSTED))).toBeNull();
    expect(f.queries).toEqual([]);
  });

  it.each([
    ["owner", "owner", false, "full"],
    ["tenant_admin", "tenant_admin", false, "full"],
    ["store_manager", "store_manager", false, "category_only"],
    ["a platform admin with no membership", null, true, "full"],
    ["a platform admin holding a store_manager membership", "store_manager", true, "full"],
  ] as const)("%s gets %s", async (_label, role, platformAdmin, disclosure) => {
    const f = fake({ role });
    const out = await loadErpPostingFailure(f.client, f.memberships, input(context({ isPlatformAdmin: platformAdmin })));
    expect(out!.disclosure).toBe(disclosure);
    expect(out!.sale!.repair).toEqual(disclosure === "full" ? { workItemRef: SALE_ITEM } : null);
    expect(out!.sale!.reason).toBe(disclosure === "full" ? REASON : null);
  });

  it("category_only never consults the store rule", async () => {
    const f = fake({ role: "store_manager" });
    await loadErpPostingFailure(f.client, f.memberships, input(context()));
    expect(f.queries.filter((q) => /FROM stores/.test(q))).toEqual([]);
  });

  it("a deleted store gets no handle under full", async () => {
    const f = fake({ role: "owner", storeLive: false });
    const out = await loadErpPostingFailure(f.client, f.memberships, input(context()));
    expect(out!.sale).toMatchObject({ reason: REASON, repair: null });
  });

  it("a token principal never gets the platform-admin bypass", async () => {
    const f = fake({ role: "store_manager", platformAdmin: true });
    const out = await loadErpPostingFailure(f.client, f.memberships, input(context({ source: "token", isPlatformAdmin: true })));
    expect(out!.disclosure).toBe("category_only");
  });

  it("a failed side whose dead-letter was repaired meanwhile reads as changed: both sides null", async () => {
    const f = fake({ role: "owner", rows: [] });
    expect(await loadErpPostingFailure(f.client, f.memberships, input(context()))).toEqual({
      disclosure: "full",
      sale: null,
      reversal: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The shared tenant role gate
// ---------------------------------------------------------------------------

describe("RT-1061 tenant role gate (RolesGuard steps 4-7, shared with the disclosure)", () => {
  const lookups = (role: string | null, platformAdmin = false): TenantRoleGateLookups & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      isPlatformAdmin: async () => {
        calls.push("isPlatformAdmin");
        return platformAdmin;
      },
      roleCodeInTenant: async () => {
        calls.push("roleCodeInTenant");
        return role;
      },
    };
  };
  const session = { kind: "session" as const, userId: USER };

  it("the posting backlog roles are owner and tenant_admin", () => {
    expect([...POSTING_BACKLOG_ROLES]).toEqual(["owner", "tenant_admin"]);
  });

  it("a session platform admin is allowed before any tenant or role check", async () => {
    const l = lookups(null);
    expect(await decideTenantRoleGate({ principal: session, contextIsPlatformAdmin: true, tenantId: null, accepted: ["owner"] }, l)).toEqual({
      allowed: true,
      via: "platform_admin",
    });
    expect(l.calls).toEqual([]);
    const db = lookups(null, true);
    expect(await isSessionPlatformAdmin(session, false, db)).toBe(true);
    expect(db.calls).toEqual(["isPlatformAdmin"]);
  });

  it("a token never gets the bypass and is not even looked up", async () => {
    const l = lookups("owner", true);
    expect(await isSessionPlatformAdmin({ kind: "token", userId: USER }, true, l)).toBe(false);
    expect(l.calls).toEqual([]);
  });

  it.each([
    ["no tenant", { principal: session, tenantId: null }, null, { allowed: false, reason: "no_tenant" }],
    ["a userless token", { principal: { kind: "token" as const, userId: null }, tenantId: TENANT }, "owner", { allowed: false, reason: "no_user" }],
    ["no membership", { principal: session, tenantId: TENANT }, null, { allowed: false, reason: "role" }],
    ["a role outside the list", { principal: session, tenantId: TENANT }, "store_manager", { allowed: false, reason: "role" }],
    ["a role in the list", { principal: session, tenantId: TENANT }, "tenant_admin", { allowed: true, via: "role" }],
  ] as const)("%s", async (_label, partial, role, expected) => {
    expect(
      await decideTenantRoleGate({ ...partial, contextIsPlatformAdmin: false, accepted: POSTING_BACKLOG_ROLES }, lookups(role)),
    ).toEqual(expected);
  });
});
