import { signOut } from "@/lib/client";
/**
 * Sign-out action (SF-2, T030, S6). Calls signOut, then clears the Query cache
 * and routes to SF-1 — regardless of status (resolveSignOut always signs out
 * locally; the console holds no authoritative session). The in-memory
 * "session gone" reason (RT-930) goes with it.
 */
import { clearSessionGone } from "@/platform/session/sessionGone";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { resolveSignOut } from "./sign-out";

export function useSignOut(): () => Promise<void> {
  const qc = useQueryClient();
  const navigate = useNavigate();

  return async function doSignOut(): Promise<void> {
    const res = await signOut();
    resolveSignOut(res.status); // always { signedOut: true }
    qc.clear();
    clearSessionGone();
    navigate("/signin", { replace: true });
  };
}
