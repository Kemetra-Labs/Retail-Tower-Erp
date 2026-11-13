/**
 * Provider-side provisioning of a NEW signup owner (RT-1350 slice 3, fallback A).
 *
 * Runs BEFORE the database transaction, like invitation acceptance (RT-937): the new
 * owner's password lives at the identity provider, not in Backend-Core (D-A). The
 * emailed single-use token is the email proof, so the provider user is created with
 * the verified email.
 *
 * Differences from invitation acceptance (coordinator decision 2026-11-13, RT-1350):
 *   - A provider user that already exists WITH a password and has no Backend-Core user
 *     is ADOPTED on the email proof: the submitted password is not applied (an existing
 *     password is never overwritten here) and the identity link is created.
 *   - A provider user that exists WITHOUT a password (a half-done earlier attempt) gets
 *     the submitted password.
 *
 * The provider's own password policy decides `setActivePassword`; a rejection is the
 * generic invalid. An outage is `unavailable` (503), never an invalid token. The
 * refresh token of a provider sign-in is never requested here.
 */
import type { ExternalCredentialPort } from "../auth/external-credential.port";

export type ProvisionResult =
  | { readonly kind: "ok"; readonly subject: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export interface ProvisionInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export async function provisionProviderUser(
  external: ExternalCredentialPort,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const created = await external.createUser({ loginId: input.email, email: input.email, name: input.name });
  switch (created.kind) {
    case "created":
      return await setPassword(external, input, created.userId);
    case "unavailable":
    case "unconfigured":
      return { kind: "unavailable" };
    case "rejected":
      return await adoptExisting(external, input);
  }
}

async function adoptExisting(external: ExternalCredentialPort, input: ProvisionInput): Promise<ProvisionResult> {
  const loaded = await external.loadUser(input.email);
  switch (loaded.kind) {
    case "unavailable":
    case "unconfigured":
      return { kind: "unavailable" };
    case "not_found":
      return { kind: "invalid" };
    case "found":
      return loaded.passwordSet ? { kind: "ok", subject: loaded.userId } : await setPassword(external, input, loaded.userId);
  }
}

async function setPassword(
  external: ExternalCredentialPort,
  input: ProvisionInput,
  subject: string,
): Promise<ProvisionResult> {
  const set = await external.setActivePassword(input.email, input.password);
  if (set.kind === "ok") return { kind: "ok", subject };
  return set.kind === "rejected" ? { kind: "invalid" } : { kind: "unavailable" };
}
