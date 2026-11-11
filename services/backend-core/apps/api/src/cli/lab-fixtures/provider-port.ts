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
  /** `code` is the provider's error code (e.g. `E011002`) when it sent a well-formed one; never a message or body. */
  | { readonly kind: "rejected"; readonly code?: string }
  | { readonly kind: "unavailable" };

/** Test-user lookup and creation (faked in unit tests). */
export interface FixtureIdentityProvider {
  findFixtureUser(loginId: string): Promise<FixtureLookup>;
  /** The provider requires an email or phone even for a test user; the address is never mailed. */
  createTestUser(loginId: string, email: string, name: string): Promise<FixtureCreate>;
}
