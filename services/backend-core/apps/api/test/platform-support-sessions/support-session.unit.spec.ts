/**
 * RT-414 support-session units: the refusal envelope, route coverage, and the
 * audit metadata builders (allowlist, no other-tenant session on a
 * `support_session_required` row). The gate's admission (RT-1468) is
 * support-session.direct.unit.spec.ts. Docker-free; the HTTP + RLS behavior is
 * platform-support-sessions.http.integration.spec.ts.
 */
import "reflect-metadata";

import { Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { PoolClient } from "pg";

import { coveredTarget, routeTemplate } from "../../src/platform-support-sessions/support-session.coverage";
import { supportSessionRefusal } from "../../src/platform-support-sessions/support-session.gate";
import {
  recordCrossTenantAccess,
  recordSupportSessionChange,
  toSupportSessionBody,
  toSupportSessionSummary,
  type SupportSessionRecord,
} from "../../src/platform-support-sessions/support-session.store";

const TENANT = "04140000-0000-4000-8000-0000000000a1";
const OTHER = "04140000-0000-4000-8000-0000000000b1";

function record(overrides: Partial<SupportSessionRecord> = {}): SupportSessionRecord {
  return {
    id: "04140000-0000-4000-8000-00000000f001",
    authSessionId: "04140000-0000-4000-8000-00000000f002",
    userId: "04140000-0000-4000-8000-00000000f003",
    tenantId: TENANT,
    purpose: "incident",
    ticketRef: "ZD-1",
    openedAt: new Date("2026-10-21T08:00:00Z"),
    renewedAt: null,
    expiresAt: new Date("2026-10-21T09:00:00Z"),
    renewalCapAt: new Date("2026-10-21T16:00:00Z"),
    endedAt: null,
    endReason: null,
    status: "active",
    ...overrides,
  };
}


describe("supportSessionRefusal", () => {
  it("is a 403 with the stable code and a non-disclosing message", () => {
    for (const code of [
      "support_session_required",
      "support_session_expired",
      "support_session_read_only",
      "origin_rejected",
    ] as const) {
      const err = supportSessionRefusal(code);
      expect(err.getStatus()).toBe(403);
      const payload = err.getResponse() as { code: string; message: string };
      expect(payload.code).toBe(code);
      expect(payload.message).not.toMatch(/[0-9a-f]{8}-/);
    }
  });
});

// ----- coverage -------------------------------------------------------------

class TenantContextGuard {
  canActivate(): boolean {
    return true;
  }
}

@Controller("api/v1/stores")
@UseGuards(TenantContextGuard)
class StoresController {
  @Get(":store_id")
  read(): void {}
}

@Controller("api/v1/tenants")
class TenantsController {
  @Get(":id/members")
  listMembers(): void {}
  @Patch(":id")
  update(): void {}
  @Get(":id")
  read(): void {}
}

@Controller("api/v1/context")
class ContextController {
  @Post("store")
  switchStore(): void {}
  @Get("me")
  me(): void {}
}

function ctx(cls: object, handler: string): ExecutionContext {
  const target = cls as { prototype: Record<string, unknown> };
  return {
    getClass: () => cls,
    getHandler: () => target.prototype[handler],
  } as unknown as ExecutionContext;
}

describe("coveredTarget / routeTemplate", () => {
  it("covers TenantContextGuard routes on the active tenant", () => {
    expect(coveredTarget(ctx(StoresController, "read"))).toEqual({ kind: "active-tenant" });
    expect(routeTemplate(ctx(StoresController, "read"))).toBe("/api/v1/stores/:store_id");
  });

  it("covers the path tenants and switchActiveStore", () => {
    expect(coveredTarget(ctx(TenantsController, "listMembers"))).toEqual({ kind: "path-tenant", param: "id" });
    expect(coveredTarget(ctx(TenantsController, "update"))).toEqual({ kind: "path-tenant", param: "id" });
    expect(coveredTarget(ctx(ContextController, "switchStore"))).toEqual({ kind: "active-tenant" });
  });

  it("leaves platform-scope and context reads uncovered", () => {
    expect(coveredTarget(ctx(TenantsController, "read"))).toBeNull();
    expect(coveredTarget(ctx(ContextController, "me"))).toBeNull();
  });

  it("falls back to 'unknown' without route metadata", () => {
    const bare = { getClass: () => ({}), getHandler: () => ({}) } as unknown as ExecutionContext;
    expect(routeTemplate(bare)).toBe("unknown");
  });
});

// ----- store builders -------------------------------------------------------

function fakeClient(): { client: PoolClient; inserted: () => unknown[][] } {
  const calls: unknown[][] = [];
  const client = {
    query: jest.fn(async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, inserted: () => calls };
}

function metadataOf(params: unknown[]): Record<string, unknown> {
  return JSON.parse(String(params[6])) as Record<string, unknown>;
}

describe("audit rows", () => {
  it("records opened / ended with the allowlist only", async () => {
    const { client, inserted } = fakeClient();
    await recordSupportSessionChange(client, "platform.support_session.opened", record(), "rid-1");
    await recordSupportSessionChange(
      client,
      "platform.support_session.ended",
      record({ status: "ended", endedAt: new Date(), endReason: "operator" }),
      null,
    );
    const [opened, ended] = inserted();
    expect(opened![2]).toBe("platform_support");
    expect(opened![3]).toBe(TENANT);
    expect(metadataOf(opened!)).toEqual({
      actor_kind: "platform_admin",
      outcome: "succeeded",
      support_session_id: record().id,
      purpose: "incident",
      ticket_ref: "ZD-1",
      expires_at: "2026-10-21T09:00:00.000Z",
    });
    expect(metadataOf(ended!)).toMatchObject({ end_reason: "operator" });
    expect(metadataOf(ended!)).not.toHaveProperty("expires_at");
  });

  it("never names another tenant's session on a support_session_required row", async () => {
    const { client, inserted } = fakeClient();
    await recordCrossTenantAccess(client, {
      tenantId: TENANT,
      actorUserId: record().userId,
      requestId: null,
      method: "get",
      route: "/api/v1/stores",
      session: record({ tenantId: OTHER }),
      reason: "support_session_required",
    });
    expect(metadataOf(inserted()[0]!)).toEqual({
      actor_kind: "platform_admin",
      outcome: "rejected",
      reason: "support_session_required",
      support_session_id: null,
      purpose: null,
      method: "GET",
      route: "/api/v1/stores",
    });
  });

  it("bounds the method and route", async () => {
    const { client, inserted } = fakeClient();
    await recordCrossTenantAccess(client, {
      tenantId: null,
      actorUserId: record().userId,
      requestId: "rid",
      method: "OPTIONS",
      route: "",
      session: record(),
    });
    const meta = metadataOf(inserted()[0]!);
    expect(meta).toMatchObject({ outcome: "succeeded", method: "GET", route: "unknown" });
    expect(meta).not.toHaveProperty("reason");
  });
});

describe("wire shapes", () => {
  it("projects the session and hides an ended one from the banner", () => {
    expect(toSupportSessionBody(record())).toMatchObject({
      id: record().id,
      status: "active",
      renewed_at: null,
      ended_at: null,
      end_reason: null,
    });
    expect(toSupportSessionSummary(record())).toEqual({
      id: record().id,
      tenant_id: TENANT,
      purpose: "incident",
      ticket_ref: "ZD-1",
      status: "active",
      expires_at: "2026-10-21T09:00:00.000Z",
      renewal_cap_at: "2026-10-21T16:00:00.000Z",
    });
    expect(toSupportSessionSummary(record({ status: "ended" }))).toBeNull();
  });
});
