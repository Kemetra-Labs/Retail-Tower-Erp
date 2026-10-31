import { signOut } from "@/lib/client";
/**
 * Sign-out action (SF-2, T030, S6). Calls signOut, then clears the Query cache
 * and routes to SF-1 — regardless of status (resolveSignOut always signs out
 * locally; the console holds no authoritative session). The in-memory
 * "session gone" reason (RT-930) goes with it.
 *
 * RT-807: a sign-out request that never answers (network error) still signs
 * out locally. The cookie session then ends on the server by expiry; nothing
 * the console holds is left behind.
 */
import { clearSessionGone } from "@/platform/session/sessionGone";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { resolveSignOut } from "./sign-out";

export function useSignOut(): () => Promise<void> {
  const qc = useQueryClient();
  const navigate = useNavigate();

  return async function doSignOut(): Promise<void> {
    try {
      const res = await signOut();
      resolveSignOut(res.status); // always { signedOut: true }
    } catch {
      // No response: sign out locally all the same (see above).
    }
    qc.clear();
    clearSessionGone();
    navigate("/signin", { replace: true });
  };
}
