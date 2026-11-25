/**
 * Jira RT-1600 — the wiring of the redistribution proposal routes (`RedistributionProposalsController`), without a
 * database. The behaviour over real Postgres is `redistribution-proposals.db.spec.ts` and
 * `redistribution-proposals.http.integration.spec.ts`.
 *
 * Pins: the six RT-1599 paths and methods, each documented status (a Nest `@Post` answers 201 unless told otherwise),
 * the guard order (session, tenant, role, then the allowlist gate, all before the idempotency interceptor), the role
 * gate with the non-disclosing 404 default, `Idempotency-Key` on every command, the console rate-limit class of each
 * route, and the live-phase mark on accept only.
 */
import 'reflect-metadata';

import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DashboardAuthGuard } from '../../../src/auth/dashboard-auth.guard';
import { ROLES_METADATA_KEY } from '../../../src/auth/roles.decorator';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { resolveConsoleRateLimitClass } from '../../../src/console-rate-limit/console-rate-limit.classify';
import { TenantContextGuard } from '../../../src/context/tenant-context.guard';
import { IDEMPOTENT_POLICY_KEY } from '../../../src/idempotency/idempotent.decorator';
import { RedistributionPhaseGuard } from '../../../src/inventory/redistribution-proposals/redistribution-phase.guard';
import { RedistributionProposalsController } from '../../../src/inventory/redistribution-proposals/redistribution-proposals.controller';
import { loadClassFiles } from '../../_helpers/console-rate-limit-classes';

const BASE = 'api/inventory/v1/redistribution-proposals';
const GET = 0;
const POST = 1;

/** operationId -> [method, path, status (null = Nest default for the method), idempotent command]. */
const OPS: Record<string, readonly [number, string, number | null, boolean]> = {
  createRedistributionProposal: [POST, BASE, 201, true],
  listRedistributionProposals: [GET, BASE, null, false],
  getRedistributionProposal: [GET, `${BASE}/:proposalId`, null, false],
  reviewRedistributionProposal: [POST, `${BASE}/:proposalId/review`, 200, true],
  acceptRedistributionProposal: [POST, `${BASE}/:proposalId/accept`, 200, true],
  rejectRedistributionProposal: [POST, `${BASE}/:proposalId/reject`, 200, true],
};

const handler = (name: string): (...args: unknown[]) => unknown =>
  Object.getOwnPropertyDescriptor(RedistributionProposalsController.prototype, name)?.value as (...args: unknown[]) => unknown;

describe('RedistributionProposalsController wiring', () => {
  it('serves exactly the six contract operations, by their operationId', () => {
    const own = Object.getOwnPropertyNames(RedistributionProposalsController.prototype).filter((n) => n !== 'constructor');
    expect(own.sort()).toEqual(Object.keys(OPS).sort());
  });

  it.each(Object.entries(OPS))('%s answers on its contract method and path with its documented status', (name, [method, path, status]) => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler(name))).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler(name))).toBe(path);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(status ?? undefined);
  });

  it.each(Object.entries(OPS))('%s requires Idempotency-Key exactly when it is a command', (name, [, , , command]) => {
    const policy = Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler(name));
    if (command) expect(policy).toBe('required');
    else expect(policy).toBeUndefined();
  });

  it('authenticates the human session, then the tenant, then the role, then the allowlist gate, for every route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RedistributionProposalsController)).toEqual([
      DashboardAuthGuard,
      TenantContextGuard,
      RolesGuard,
      RedistributionPhaseGuard,
    ]);
  });

  it.each(Object.keys(OPS))('%s admits owner and tenant_admin only, and answers any other role with the non-disclosing 404', (name) => {
    const roles = Reflect.getMetadata(ROLES_METADATA_KEY, handler(name)) as { any: string[]; denyAs?: number };
    expect(roles.any).toEqual(['owner', 'tenant_admin']);
    expect(roles.denyAs ?? 404).toBe(404);
  });

  it.each(Object.keys(OPS))('%s carries the rate-limit class of its contract class file', (name) => {
    const declared = Object.assign({}, ...loadClassFiles().map((f) => f.classes)) as Record<string, string>;
    expect(resolveConsoleRateLimitClass(RedistributionProposalsController, handler(name))).toBe(declared[name]);
  });

  it('marks only accept as a live-phase route', () => {
    const reflector = new Reflector();
    const live = Object.keys(OPS).filter((name) => reflector.get('dp2:redistribution:live-phase', handler(name)) === true);
    expect(live).toEqual(['acceptRedistributionProposal']);
  });
});

describe('RedistributionProposalsController caller', () => {
  const service = new Proxy({}, { get: () => async () => ({ ok: true }) });
  const controller = new RedistributionProposalsController(service as never);
  const PROPOSAL = '0198b000-0000-7000-8000-000000000001';

  it.each([
    ['no context', undefined],
    ['no tenant', { tenantId: null, userId: '0198b000-0000-7000-8000-0000000000aa' }],
    ['no user', { tenantId: '0198b000-0000-7000-8000-0000000000bb', userId: null }],
  ])('refuses a request with %s (401), never trusting the body', async (_label, context) => {
    await expect(controller.getRedistributionProposal({ context } as never, PROPOSAL)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 200 when the compute found nothing to move and 201 when it stored a proposal', async () => {
    const context = { tenantId: '0198b000-0000-7000-8000-0000000000bb', userId: '0198b000-0000-7000-8000-0000000000aa' };
    for (const status of [200, 201] as const) {
      const svc = { compute: async () => ({ status, body: { status } }) };
      const c = new RedistributionProposalsController(svc as never);
      const seen: number[] = [];
      const response = { status: (s: number) => seen.push(s) };
      await expect(c.createRedistributionProposal({ context } as never, {}, response as never)).resolves.toEqual({ status });
      expect(seen).toEqual([status]);
    }
  });
});
