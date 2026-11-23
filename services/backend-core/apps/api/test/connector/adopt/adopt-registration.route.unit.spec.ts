/**
 * RT-1557 — the adopt route over HTTP with the REAL `ConnectorModule` wiring, the real
 * `PlatformAdminGuard` and the real controller, and no database (no Docker): the session guard
 * is a header stand-in (as `HeaderSessionAuthGuard` in the scoped harness), the membership lookup
 * and the adoption service are scripted.
 *
 * Proves: the guards (no session 401, a non-platform-admin 403 BEFORE any id is validated and
 * before the service runs), the id validation (400), the 404 / 409 mapping with the contract's
 * stable codes, the 200 body with `Cache-Control: no-store`, that the actor and the request's
 * path tenant reach the service, that the route is declared with the guards in the contract's
 * order, and that support-session enforcement does not cover it.
 */
import "reflect-metadata";

import { GUARDS_METADATA } from "@nestjs/common/constants";
import { type CanActivate, type ExecutionContext, type INestApplication, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, PlatformAdminGuard } from "../../../src/audit";
import { SessionOnlyAdminGuard } from "../../../src/auth";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { ConnectorAdoptionController } from "../../../src/connector/connector-adoption.controller";
import { ConnectorAdoptionService, type AdoptResult } from "../../../src/connector/connector-adoption.service";
import { ConnectorModule } from "../../../src/connector/connector.module";
import { MembershipRepository } from "../../../src/context";
import { AUTH_LOOKUP_POOL, PG_POOL } from "../../../src/database";
import { coveredTarget } from "../../../src/platform-support-sessions/support-session.coverage";

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const INSTANCE = "0c000000-0000-7000-8000-00000c018a01";
const PLATFORM_ADMIN = "0b000000-0000-7000-8000-0000000000b2";
const TENANT_OWNER = "0a000000-0000-7000-8000-0000000000a2";
const ROUTE = `/api/v1/platform/tenants/${TENANT}/connector-instances/${INSTANCE}/adopt`;

/** `x-test-user` names the session user; no header is no session (401). */
const headerSession: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; principal?: unknown }>();
    const userId = req.headers["x-test-user"];
    if (!userId) throw new UnauthorizedException("Unauthorized");
    req.principal = { kind: "session", sessionId: "s", userId };
    return true;
  },
};

let app: INestApplication;
let nextResult: AdoptResult;
const adoptCalls: unknown[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ConnectorModule] })
    .overrideProvider(PG_POOL)
    .useValue({})
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue({})
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue({ enqueue: async () => undefined })
    .overrideGuard(SessionOnlyAdminGuard)
    .useValue(headerSession)
    .overrideProvider(MembershipRepository)
    .useValue({ isPlatformAdmin: async (userId: string) => userId === PLATFORM_ADMIN })
    .overrideProvider(ConnectorAdoptionService)
    .useValue({
      adopt: async (input: unknown): Promise<AdoptResult> => {
        adoptCalls.push(input);
        return nextResult;
      },
    })
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  adoptCalls.length = 0;
  nextResult = { kind: "not_found" };
});

const post = (path = ROUTE, user: string | null = PLATFORM_ADMIN): request.Test => {
  const req = request(app.getHttpServer()).post(path);
  return user === null ? req : req.set("x-test-user", user);
};
const codeOf = (res: request.Response): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe("platformAdoptConnectorRegistration route", () => {
  it("is 401 without a session, and the service is not reached", async () => {
    const res = await post(ROUTE, null);
    expect({ status: res.status, code: codeOf(res) }).toEqual({ status: 401, code: "unauthorized" });
    expect(adoptCalls).toEqual([]);
  });

  it("is 403 forbidden for a session that is not a platform admin (a tenant owner too), before the ids are validated", async () => {
    const res = await post(ROUTE, TENANT_OWNER);
    expect({ status: res.status, code: codeOf(res) }).toEqual({ status: 403, code: "forbidden" });
    const malformed = await post(`/api/v1/platform/tenants/not-a-uuid/connector-instances/${INSTANCE}/adopt`, TENANT_OWNER);
    expect({ status: malformed.status, code: codeOf(malformed) }).toEqual({ status: 403, code: "forbidden" });
    expect(adoptCalls).toEqual([]);
  });

  it("is 400 validation_error for a malformed tenant id or registration id", async () => {
    for (const path of [
      `/api/v1/platform/tenants/not-a-uuid/connector-instances/${INSTANCE}/adopt`,
      `/api/v1/platform/tenants/${TENANT}/connector-instances/nope/adopt`,
    ]) {
      const res = await post(path);
      expect({ status: res.status, code: codeOf(res) }).toEqual({ status: 400, code: "validation_error" });
    }
    expect(adoptCalls).toEqual([]);
  });

  it("passes the path tenant, the registration id and the acting admin to the service (request id null: this app has no request-id interceptor)", async () => {
    nextResult = { kind: "not_found" };
    await post();
    expect(adoptCalls).toEqual([{ tenantId: TENANT, instanceId: INSTANCE, actorUserId: PLATFORM_ADMIN, requestId: null }]);
  });

  it("is a non-disclosing 404 not_found", async () => {
    nextResult = { kind: "not_found" };
    const res = await post();
    expect({ status: res.status, code: codeOf(res) }).toEqual({ status: 404, code: "not_found" });
  });

  it("is 409 registration_disabled for a disabled registration", async () => {
    nextResult = { kind: "disabled" };
    const res = await post();
    expect({ status: res.status, code: codeOf(res) }).toEqual({ status: 409, code: "registration_disabled" });
  });

  it("is 409 already_managed for a registration that is managed and not adopted by this caller", async () => {
    nextResult = { kind: "already_managed" };
    const res = await post();
    expect({ status: res.status, code: codeOf(res) }).toEqual({ status: 409, code: "already_managed" });
  });

  it("is 200 with the projection and Cache-Control no-store, for the first call and for a repeat", async () => {
    for (const outcome of ["adopted", "already_adopted"] as const) {
      const body = { outcome, tenantId: TENANT, instanceId: INSTANCE, managedBy: "provisioner" as const, environment: "pilot", erpnextSiteRef: "lab.localhost" };
      nextResult = { kind: "ok", body };
      const res = await post();
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual(body);
    }
  });
});

describe("platformAdoptConnectorRegistration declaration", () => {
  const guardNames = (target: object): string[] =>
    ((Reflect.getMetadata(GUARDS_METADATA, target) as Array<{ name: string }> | undefined) ?? []).map((g) => g.name);

  it("runs SessionOnlyAdminGuard, then PlatformAdminGuard, and never TenantContextGuard", () => {
    expect(guardNames(ConnectorAdoptionController)).toEqual([SessionOnlyAdminGuard.name, PlatformAdminGuard.name]);
    expect(guardNames(ConnectorAdoptionController.prototype.adopt)).toEqual([]);
  });

  it("is not covered by support-session enforcement (no TenantContextGuard, not a named path-tenant handler)", () => {
    const ctx = {
      getClass: () => ConnectorAdoptionController,
      getHandler: () => ConnectorAdoptionController.prototype.adopt,
    } as unknown as ExecutionContext;
    expect(coveredTarget(ctx)).toBeNull();
  });
});
