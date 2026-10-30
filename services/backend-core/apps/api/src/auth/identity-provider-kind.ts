/**
 * identity-provider-kind.ts — RT-791 `IDENTITY_PROVIDER` selection.
 *
 * The one place that reads which provider verifies operator tokens. The two
 * factories in `identity-provider.factory.ts` (`operatorTokenVerifierFactory`,
 * `identityProviderFactory`) call it, so every module that builds a verifier
 * or an identity adapter switches together.
 *
 * Descope is the only provider since RT-800 (owner decision 2026-10-29, Clerk
 * retired with no transition period):
 *   - unset / empty → `descope`;
 *   - `descope` (surrounding whitespace ignored, otherwise exact);
 *   - anything else — including the retired `clerk` — throws at boot, in every
 *     environment (fail closed: a stale or mistyped value must never silently
 *     select a provider the operator did not pick).
 */
export type IdentityProviderKind = "descope";

const KINDS: readonly IdentityProviderKind[] = ["descope"];

export function identityProviderKind(): IdentityProviderKind {
  const raw = (process.env["IDENTITY_PROVIDER"] ?? "").trim();
  if (raw === "") return "descope";
  const kind = KINDS.find((k) => k === raw);
  if (!kind) {
    throw new Error("IDENTITY_PROVIDER must be 'descope' (fail closed)");
  }
  return kind;
}
