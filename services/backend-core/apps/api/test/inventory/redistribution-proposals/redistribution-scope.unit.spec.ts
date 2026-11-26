/**
 * Jira RT-1600 (review S1) — the store-scope gate: the whole redistribution feature needs tenant-wide store access,
 * resolved by the operator scope rule (RT-51 D6 / RT-131, `readScope`): owner and tenant_admin are not narrowed by the
 * active store, but a `specific` membership stays specific and gets the non-disclosing 404. A session platform admin
 * is admitted, as `RolesGuard` admits it on every `@Roles` operation.
 */
import { readScope } from '../../../src/context/operator-store-scope';
import type { ResolvedContext } from '../../../src/context/types';
import { hasTenantWideAccess } from '../../../src/inventory/redistribution-proposals/redistribution-scope';

const TENANT = '0190f5a2-3b4c-7d8e-9f01-000000000001';
const USER = '0190f5a2-3b4c-7d8e-9f01-0000000000c1';
const X = '0190f5a2-3b4c-7d8e-9f01-0000000000b1';

const ctx = (over: Partial<ResolvedContext>): ResolvedContext =>
  ({ tenantId: TENANT, userId: USER, storeId: null, isPlatformAdmin: false, source: 'session', storeAccess: { kind: 'all' }, ...over }) as ResolvedContext;

const gate = (context: ResolvedContext, roleCode: string | null): boolean => hasTenantWideAccess(context, readScope({ context, roleCode }));

describe('hasTenantWideAccess over the operator store scope', () => {
  it.each(['owner', 'tenant_admin'])('admits a %s with access to all stores, also with an active store selected', (role) => {
    expect(gate(ctx({}), role)).toBe(true);
    expect(gate(ctx({ storeId: X }), role)).toBe(true);
  });

  it.each(['owner', 'tenant_admin'])('refuses a %s whose membership is limited to specific stores', (role) => {
    expect(gate(ctx({ storeAccess: { kind: 'specific', storeIds: [X] } }), role)).toBe(false);
  });

  it('refuses a context whose store access was never resolved (fail closed)', () => {
    const { storeAccess: _omitted, ...unresolved } = ctx({});
    expect(gate(unresolved as ResolvedContext, 'owner')).toBe(false);
  });

  it('admits a session platform admin whatever its scope, but not a platform admin on a token', () => {
    const narrow = { storeAccess: { kind: 'specific', storeIds: [] } } as Partial<ResolvedContext>;
    expect(gate(ctx({ isPlatformAdmin: true, ...narrow }), null)).toBe(true);
    expect(gate(ctx({ isPlatformAdmin: true, source: 'token', ...narrow }), null)).toBe(false);
  });
});
