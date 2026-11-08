/**
 * Jira RT-451 S2 — HTTP layer of the tenant's tracked-selling switch
 * (`GET` / `PUT /api/inventory/v1/settings/tracked-selling`).
 *
 * The controller boundary against a fake service (no DB), with the REAL
 * `RolesGuard` over a stubbed membership lookup, the real Zod pipe and the
 * real `GlobalExceptionFilter` (the safety-TTL HTTP suite's model):
 *   - roles: the read admits owner, tenant_admin and store_manager; the write
 *     owner and tenant_admin; any other role is a 403 that never reaches the
 *     service, and it comes BEFORE the deployment gate's 404;
 *   - the gate: while POS_TRACKED_SELLING_ENABLED is off, an admitted caller
 *     gets the non-disclosing 404 and the service is never called;
 *   - the strict body: an unknown key or a non-boolean `enabled` is a 400
 *     `validation_error`;
 *   - the service's refusal reaches the client as 409 with
 *     `error.code = tracked_selling_preconditions_unmet`;
 *   - the service receives the server-resolved caller only.
 *
 * What the service does with the role (a store_manager's on/off-only body)
 * is proven against Postgres in `tracked-selling-setting.spec.ts`.
 */
import 'reflect-metadata';

import {
  ConflictException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { TRACKED_SELLING_GATE } from '../../../src/catalog/sales/tracked-lines/tracked-selling-gate';
import { GlobalExceptionFilter } from '../../../src/common/exception.filter';
import { MembershipRepository } from '../../../src/context/membership.repository';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import type { ResolvedContext } from '../../../src/context/types';
import { TrackedSellingSettingController } from '../../../src/inventory/tracked-selling/tracked-selling-setting.controller';
import {
  TrackedSellingSettingService,
  type TrackedSellingCaller,
} from '../../../src/inventory/tracked-selling/tracked-selling-setting.service';

const TENANT = '0a000000-0000-7000-8000-000000451301';
const USER = '0a000000-0000-7000-8000-000000451302';
const PATH = '/api/inventory/v1/settings/tracked-selling';
const BODY = { enabled: false, changedAt: null, changedBy: null, preconditionsMet: false, unmetPreconditions: [] };

class FakeService {
  public calls: Array<{ op: string; caller: TrackedSellingCaller; enabled?: boolean }> = [];
  public refuse = false;
  async getSetting(caller: TrackedSellingCaller) {
    this.calls.push({ op: 'get', caller });
    return BODY;
  }
  async setSetting(caller: TrackedSellingCaller, enabled: boolean) {
    this.calls.push({ op: 'set', caller, enabled });
    if (this.refuse) {
      throw new ConflictException({
        code: 'tracked_selling_preconditions_unmet',
        message: 'Tracked selling cannot be switched on until its preconditions hold.',
      });
    }
    return { ...BODY, enabled };
  }
}

class FakeMemberships {
  public role: string | null = 'owner';
  async findRoleCodeForUserInTenant(): Promise<string | null> {
    return this.role;
  }
  async isPlatformAdmin(): Promise<boolean> {
    return false;
  }
}

/** Publishes the session principal and context, as the real guards do. */
class ContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: unknown }>();
    req.principal = { kind: 'session', sessionId: 's1', userId: USER };
    req.context = {
      userId: USER,
      tenantId: TENANT,
      storeId: null,
      isPlatformAdmin: false,
      source: 'session',
      storeAccess: { kind: 'all' },
    };
    return true;
  }
}
class PassAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

let app: INestApplication;
const fake = new FakeService();
const memberships = new FakeMemberships();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [TrackedSellingSettingController],
    providers: [
      { provide: TrackedSellingSettingService, useValue: fake },
      { provide: MembershipRepository, useValue: memberships },
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new PassAuthGuard())
    .overrideGuard(TenantContextGuard)
    .useValue(new ContextGuard())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  delete process.env[TRACKED_SELLING_GATE];
  if (app) await app.close();
});

beforeEach(() => {
  fake.calls = [];
  fake.refuse = false;
  memberships.role = 'owner';
  delete process.env[TRACKED_SELLING_GATE];
});

const get = () => request(app.getHttpServer()).get(PATH);
const put = (body: unknown) => request(app.getHttpServer()).put(PATH).send(body as object);
const gateOn = () => {
  process.env[TRACKED_SELLING_GATE] = 'true';
};

describe('the deployment gate', () => {
  it('answers an admitted caller the non-disclosing 404 and never reaches the service', async () => {
    const read = await get();
    const write = await put({ enabled: true });
    expect([read.status, write.status]).toEqual([404, 404]);
    expect(read.body.error.code).toBe(write.body.error.code);
    expect(fake.calls).toEqual([]);
  });
});

describe('roles (403 before the gate)', () => {
  it.each(['store_staff', null])('refuses role %s on both routes with 403, gate off or on', async (role) => {
    memberships.role = role;
    expect((await get()).status).toBe(403);
    expect((await put({ enabled: false })).status).toBe(403);
    gateOn();
    expect((await get()).status).toBe(403);
    expect((await put({ enabled: false })).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it('admits a store_manager to the read and refuses the write with 403, before the gate', async () => {
    memberships.role = 'store_manager';
    expect((await put({ enabled: false })).status).toBe(403);
    gateOn();
    expect((await get()).status).toBe(200);
    expect((await put({ enabled: false })).status).toBe(403);
    expect(fake.calls.map((c) => c.op)).toEqual(['get']);
  });

  it.each(['owner', 'tenant_admin'])('admits %s to the read and the write', async (role) => {
    memberships.role = role;
    gateOn();
    expect((await get()).status).toBe(200);
    expect((await put({ enabled: true })).status).toBe(200);
  });
});

describe('the strict body and the service boundary', () => {
  it.each([
    ['an unknown key', { enabled: true, tenantId: TENANT }],
    ['a string enabled', { enabled: 'true' }],
    ['a missing enabled', {}],
  ])('refuses %s with 400 validation_error, never reaching the service', async (_why, body) => {
    gateOn();
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(fake.calls).toEqual([]);
  });

  it('hands the service the server-resolved caller and the value only', async () => {
    gateOn();
    expect((await put({ enabled: true })).body).toEqual({ ...BODY, enabled: true });
    expect(fake.calls).toEqual([
      { op: 'set', caller: { tenantId: TENANT, userId: USER, isPlatformAdmin: false }, enabled: true },
    ]);
  });

  it('carries the refusal to the client as 409 tracked_selling_preconditions_unmet', async () => {
    gateOn();
    fake.refuse = true;
    const res = await put({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('tracked_selling_preconditions_unmet');
  });
});
