/**
 * Pure planning for one cashier fixture — RT-1309.
 *
 * Given what the database already holds, decide the missing writes or refuse.
 * Never re-points or re-activates a link, never changes an existing user or
 * membership: anything that is not exactly "ours and incomplete" is refused.
 */
import { CASHIER_ROLE_CODE } from "../../pos-cashier-admissions/cashier-eligibility";

export interface LinkRow {
  readonly userId: string;
  readonly providerKey: string;
  readonly issuer: string;
  readonly subject: string;
  readonly status: string;
}

export interface FixtureDbState {
  readonly user: { readonly id: string; readonly displayName: string | null } | null;
  /** Links of that user, plus any link holding the fixture's subject. */
  readonly links: readonly LinkRow[];
  readonly membership: {
    readonly id: string;
    readonly roleCode: string;
    readonly storeAccessKind: string;
    readonly hasStore: boolean;
  } | null;
}

export interface ProviderSubject {
  readonly providerKey: string;
  readonly issuer: string;
  readonly subject: string;
}

export type FixtureAction = "create_user" | "create_link" | "create_membership" | "grant_store_access";

export type FixturePlan =
  | { readonly kind: "apply"; readonly actions: readonly FixtureAction[] }
  | { readonly kind: "refuse"; readonly reason: string };

function sameSubject(link: LinkRow, s: ProviderSubject): boolean {
  return link.providerKey === s.providerKey && link.issuer === s.issuer && link.subject === s.subject;
}

/** Refusal from the identity link rows, or null when they are consistent. */
function linkRefusal(state: FixtureDbState, s: ProviderSubject): string | null {
  const userId = state.user?.id ?? null;
  for (const link of state.links) {
    if (sameSubject(link, s) && link.userId !== userId) return "subject_linked_to_another_user";
    if (link.userId !== userId) continue;
    if (link.status !== "active") return "user_has_inactive_link";
    if (!sameSubject(link, s)) return "user_linked_to_another_subject";
  }
  return null;
}

function membershipActions(state: FixtureDbState): FixtureAction[] | string {
  const m = state.membership;
  if (m === null) return ["create_membership"];
  if (m.roleCode !== CASHIER_ROLE_CODE) return "membership_role_conflict";
  if (m.storeAccessKind === "all" || m.hasStore) return [];
  return ["grant_store_access"];
}

export function planFixture(state: FixtureDbState, s: ProviderSubject): FixturePlan {
  const refusal = linkRefusal(state, s);
  if (refusal !== null) return { kind: "refuse", reason: refusal };
  if (state.user !== null && state.user.displayName === null) {
    return { kind: "refuse", reason: "user_has_no_display_name" };
  }
  const membership = membershipActions(state);
  if (typeof membership === "string") return { kind: "refuse", reason: membership };

  const actions: FixtureAction[] = [];
  if (state.user === null) actions.push("create_user");
  const linked = state.links.some((l) => l.status === "active" && sameSubject(l, s));
  if (!linked) actions.push("create_link");
  return { kind: "apply", actions: [...actions, ...membership] };
}

/**
 * Before any provider write: a user that already holds an active link while
 * the provider has no test user for it is not ours to complete.
 */
export function preCreateRefusal(state: FixtureDbState): string | null {
  const userId = state.user?.id;
  if (userId === undefined) return null;
  return state.links.some((l) => l.userId === userId) ? "db_linked_but_provider_user_absent" : null;
}
