/**
 * RT-931 (RT-777 as-built P2-1): one rate-limit message per failure on
 * `/platform`. A surface that answers its own 429 with a message and a gated
 * retry (the directory load, the start drawer's submit) claims that 429 by its
 * sequence number on the shared clock (`seq` in src/lib/rate-limit.ts); the
 * shell hides its shared banner through the highest claimed `seq`.
 *
 * The claim is per 429, not per surface: any later 429 (the session bar's
 * renew or end, which are shell-only) bumps `seq` past the claim and the shared
 * banner is back. Nothing here releases a claim, so a retry that succeeds leaves
 * no stale "you can try again now" banner behind.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";

type Claim = (seq: number) => void;

const ClaimContext = createContext<Claim | null>(null);

export const RateLimitClaimProvider = ClaimContext.Provider;

/** The shell's side: the highest claimed `seq` and the claim function to hand down. */
export function useRateLimitClaims(): { claimedThroughSeq: number; claim: Claim } {
  const [claimedThroughSeq, setClaimedThroughSeq] = useState(0);
  const claim = useCallback(
    (seq: number) => setClaimedThroughSeq((current) => Math.max(current, seq)),
    [],
  );
  return { claimedThroughSeq, claim };
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
