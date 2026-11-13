/**
 * The human-proof port (RT-1350 slice 3, design D5): a provider-neutral check that
 * the caller of `requestSignup` passed a human challenge. The Console sends an opaque
 * token (`humanProof`); the server verifies it here, before any signup is recorded.
 *
 * Results (never an exception for an expected case):
 *   - `ok`          the challenge was solved.
 *   - `refused`     the token is invalid, reused, or minted for another site/action.
 *                   The route answers the generic 400, so the verifier is no oracle.
 *   - `unavailable` the verifier cannot answer (outage, timeout, no secret configured).
 *                   The route fails closed with 503 + Retry-After; an outage is never
 *                   reported as a failed proof.
 */
export type HumanProofResult =
  | { readonly kind: "ok" }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

export interface HumanProofInput {
  /** The opaque challenge token from the Console widget. Never logged. */
  readonly token: string;
  /** The caller's address as the server sees it, or "unknown". Never logged. */
  readonly remoteIp: string;
}

export interface HumanProofVerifier {
  verify(input: HumanProofInput): Promise<HumanProofResult>;
}

/** DI token for the verifier. Tests bind a fake with `overrideProvider`. */
export const HUMAN_PROOF_VERIFIER = "HUMAN_PROOF_VERIFIER";
