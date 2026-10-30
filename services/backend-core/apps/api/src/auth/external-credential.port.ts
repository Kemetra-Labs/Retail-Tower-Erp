/**
 * external-credential.port.ts — RT-937 (provider-neutral, like the RT-796 fence).
 *
 * What Backend-Core needs from the external identity provider that owns a
 * user's password: verify it at sign-in, replace it, and provision an invited
 * user. Services depend on THIS port and its neutral result kinds; the adapter
 * of the configured provider (`identity-provider.factory.ts`) implements it, so
 * no service, DTO, error code or log names a provider.
 *
 * Every outcome is one small result kind. No HTTP status, body, provider error
 * code or user object crosses the port, so nothing can leak through a caller's
 * response or log (FR-ISO-4). A session token returned here is NOT trusted by
 * the port: the caller verifies it with the operator token verifier and
 * compares its subject to the user's active identity link.
 *
 *   - `refused`      the credential or input was wrong (or the answer was unusable);
 *   - `unavailable`  the provider is down, rate-limited or mis-keyed: an outage is
 *                    never reported as a wrong password;
 *   - `unconfigured` a management call without its key: fail closed, no request.
 */

export type PasswordSignInResult =
  | { readonly kind: "ok"; readonly sessionJwt: string }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

export type ReplacePasswordResult = PasswordSignInResult;

export interface CreateUserInput {
  readonly loginId: string;
  readonly email: string;
  readonly name: string;
}

export type CreateUserResult =
  | { readonly kind: "created"; readonly userId: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unconfigured" };

export type LoadUserResult =
  | { readonly kind: "found"; readonly userId: string; readonly passwordSet: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unconfigured" };

export type SetPasswordResult =
  | { readonly kind: "ok" }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unconfigured" };

export interface ExternalCredentialPort {
  /**
   * The provider key and issuer an `external_identity_links` row for one of this
   * provider's users carries: the same pair the token verifier accepts, so a link
   * written for an invited user resolves at sign-in.
   */
  readonly identity: { readonly providerKey: string; readonly issuer: string };
  /** Verify a loginId + password. */
  passwordSignIn(loginId: string, password: string): Promise<PasswordSignInResult>;
  /** Replace a password the user knows (old + new), revoking their other provider sessions. */
  replacePassword(loginId: string, oldPassword: string, newPassword: string): Promise<ReplacePasswordResult>;
  /** Management: create a user whose email is verified. */
  createUser(input: CreateUserInput): Promise<CreateUserResult>;
  /** Management: read a user's id and whether a password is set. */
  loadUser(loginId: string): Promise<LoadUserResult>;
  /** Management: set an ACTIVE (non-temporary) password. */
  setActivePassword(loginId: string, password: string): Promise<SetPasswordResult>;
}

/** DI token for the port. */
export const EXTERNAL_CREDENTIAL_PORT = "EXTERNAL_CREDENTIAL_PORT";
