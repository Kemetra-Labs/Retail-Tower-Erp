/**
 * The signup-link port (RT-1350 slice 3): how the owner's email-proof link is issued
 * and checked, behind one seam so the mechanism can change without touching the
 * signup service, the contract or the schema. The contract's token is opaque.
 *
 * Adapters:
 *   - `OwnTokenSignupLinkProvider` (fallback A, RT-1350 c16859 and the spike S0 result):
 *     Backend-Core's own 32-byte token, stored only as its SHA-256 in
 *     `pending_signups.token_hash`, e-mailed by the worker.
 *   - A provider-sent link (D1-B) is NOT built: spike S0 did not prove it, and enabling the
 *     identity provider's sign-up-or-in would let anyone call the provider directly with its
 *     public project id, bypassing our human challenge and rate buckets. If it ever returns it
 *     is a new adapter (and `pending_signups.token_hash` stays NULL for it).
 *
 * RULES FOR ANY PROVIDER-SENT ADAPTER (spike S0 findings; fallback A does not use them,
 * they are recorded here so a later adapter cannot repeat the mistakes):
 *   1. Never call the provider's `updatePassword` when its verify response says a
 *      password already exists: S0 saw it overwrite an existing password with no old
 *      password. An existing password is never overwritten (contract rule).
 *   2. End a provider session minted while verifying with `POST /v1/auth/logout` on the
 *      refresh token, never `logoutall`, so POS manager sessions survive.
 *   The refresh token stays in memory only: never stored, logged or returned.
 */

export interface PrepareLinkInput {
  /** Normalised address the link goes to. */
  readonly email: string;
  /** Language of the message, from the signup form; null when none. */
  readonly locale: "ar" | "en" | null;
}

/** A link credential minted but not yet delivered. */
export interface PreparedSignupLink {
  /**
   * What `pending_signups.token_hash` stores: the SHA-256 (hex) of the token for
   * adapter A, NULL when the provider keeps the credential itself.
   */
  readonly tokenHash: string | null;
  /** Send the link. Called only AFTER the pending row is committed. May throw. */
  deliver(): Promise<void>;
}

export type VerifyLinkResult =
  | {
      readonly kind: "ok";
      /** The key of the pending row when the adapter stores a hash (A); null otherwise. */
      readonly tokenHash: string | null;
      /** The verified email when the provider reports one (a provider-sent link); null for A. */
      readonly email: string | null;
      readonly providerUserId?: string;
    }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

export interface SignupLinkProvider {
  /** Mint a credential and the means to deliver it. Pure: touches no database. */
  prepare(input: PrepareLinkInput): PreparedSignupLink;
  /** Check a presented opaque token. A refusal and an outage are different answers. */
  verify(opaqueToken: string): Promise<VerifyLinkResult>;
}

/** DI token for the provider. Tests bind a fake with `overrideProvider`. */
export const SIGNUP_LINK_PROVIDER = "SIGNUP_LINK_PROVIDER";
