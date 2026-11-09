/**
 * The identity-provider seam of the lab-fixture provisioner — RT-1309.
 *
 * Provider-neutral (RT-796 fence): the provider's own adapter implements it.
 */
export type FixtureLookup =
  | { readonly kind: "test_user"; readonly userId: string }
  | { readonly kind: "absent" }
  | { readonly kind: "not_test_user" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unavailable" };

export type FixtureCreate =
  | { readonly kind: "created"; readonly userId: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

/** Test-user lookup and creation (faked in unit tests). */
export interface FixtureIdentityProvider {
  findFixtureUser(loginId: string): Promise<FixtureLookup>;
  createTestUser(loginId: string, name: string): Promise<FixtureCreate>;
}
