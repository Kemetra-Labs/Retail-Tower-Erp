/**
 * A Docker-free `MembershipHierarchy` for the membership service unit specs
 * (RT-1028). The policy functions stay real; only the DB side is faked: the
 * actor's role, the locked active-owner count and the refusal audit write.
 */
import type { PoolClient } from "pg";

import type { ResolvedContext } from "../../src/context/types";
import type {
  MembershipActor,
  MembershipHierarchy,
  MembershipRefusalAudit,
} from "../../src/memberships/membership-hierarchy";

export interface FakeHierarchyOptions {
  /** The actor's role in the tenant; defaults to `owner`. */
  readonly actorRole?: string | null;
  /** Active owners counted under the lock; defaults to 2. */
  readonly activeOwners?: number;
}

export interface FakeMembershipHierarchy {
  readonly actorFor: jest.Mock<Promise<MembershipActor>, [PoolClient, ResolvedContext]>;
  readonly lockActiveOwnerCount: jest.Mock<Promise<number>, [PoolClient, string]>;
  readonly lockActorMembership: jest.Mock<Promise<void>, [PoolClient, ResolvedContext]>;
  readonly recordRefusal: jest.Mock<Promise<void>, [PoolClient, ResolvedContext, MembershipRefusalAudit]>;
}

export function makeFakeHierarchy(opts: FakeHierarchyOptions = {}): FakeMembershipHierarchy {
  const roleCode = opts.actorRole === undefined ? "owner" : opts.actorRole;
  return {
    actorFor: jest.fn(async (_client: PoolClient, ctx: ResolvedContext) => ({
      userId: ctx.userId,
      roleCode,
      isPlatformAdmin: ctx.isPlatformAdmin,
    })),
    lockActiveOwnerCount: jest.fn(async (_client: PoolClient, _tenantId: string) => opts.activeOwners ?? 2),
    lockActorMembership: jest.fn(async (_client: PoolClient, _ctx: ResolvedContext): Promise<void> => undefined),
    recordRefusal: jest.fn(
      async (_client: PoolClient, _ctx: ResolvedContext, _event: MembershipRefusalAudit): Promise<void> => undefined,
    ),
  };
}

export function asHierarchy(fake: FakeMembershipHierarchy): MembershipHierarchy {
  return fake as unknown as MembershipHierarchy;
}
