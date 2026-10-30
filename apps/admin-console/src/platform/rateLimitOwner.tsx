/**
 * RT-931 (RT-777 as-built P2-1): one rate-limit message per failure on
 * `/platform`. A surface that answers its own 429 with a message and a gated
 * retry (the directory load, the start drawer's submit) claims that 429 by its
 * sequence number on the shared clock (`seq` in src/lib/rate-limit.ts); the
 * shell's shared banner skips exactly the claimed `seq`s.
 *
 * The claim is per 429, not per surface: any other 429 (the session bar's renew
 * or end, which are shell-only) is still the shared banner's, whether it lands
 * after the claimed one or just before it (RT-940). Nothing here releases a
 * claim, so a retry that succeeds leaves no stale "you can try again now" banner
 * behind.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";

type Claim = (seq: number) => void;

const ClaimContext = createContext<Claim | null>(null);

export const RateLimitClaimProvider = ClaimContext.Provider;

/** The shell's side: every claimed `seq` and the claim function to hand down. */
export function useRateLimitClaims(): { claimedSeqs: ReadonlySet<number>; claim: Claim } {
  const [claimedSeqs, setClaimedSeqs] = useState<ReadonlySet<number>>(() => new Set());
  const claim = useCallback(
    (seq: number) =>
      setClaimedSeqs((current) => (current.has(seq) ? current : new Set([...current, seq]))),
    [],
  );
  return { claimedSeqs, claim };
}

/**
 * A surface's side: claim the 429 it is showing (its `seq`), or nothing while
 * `seq` is undefined. A layout effect, so the shell hides its banner before the
 * first paint of the surface's message and the two are never on screen together.
 * Outside the platform shell there is no one to tell, and it does nothing.
 */
export function useClaimRateLimit(seq: number | undefined): void {
  const claim = useContext(ClaimContext);
  useLayoutEffect(() => {
    if (claim && seq) claim(seq);
  }, [claim, seq]);
}
