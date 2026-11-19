/**
 * RT-782: the normal tenant switch (`switchActiveTenant`), offered for a tenant
 * the caller is a member of, from a directory row or after a 409
 * `already_member`. One switch at a time. The shared `switchTenant` resolves
 * whatever the server answered and then re-reads the context, so success is
 * judged on that re-read: only when the active tenant IS the one asked for does
 * the operator land on the tenant Console. A refusal and a request that never
 * got an answer are each said, never swallowed (UX Addendum A4).
 *
 * The move to the tenant Console waits until the shared context the shell reads
 * shows the new tenant. The re-read lands in the query cache first and reaches
 * subscribers on a later tick; navigating before that renders `ProtectedArea`
 * with the old context, which sends a platform admin with no membership (RT-1468)
 * straight back to `/platform`.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import type { MessageKey } from "@/i18n";
import { queryKeys } from "@/lib/query";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

type ContextRead = { kind: string; data?: { active_tenant?: { id?: string } | null } | null };

const REFUSED: MessageKey = "platform.tenants.error.switchRefused";
const NO_ANSWER: MessageKey = "platform.tenants.error.switch";
/** The switch may have landed, but the context re-read failed: nothing is claimed either way. */
const UNCONFIRMED: MessageKey = "platform.tenants.error.switchUnconfirmed";

/** Null when the re-read context shows the tenant active; otherwise why it did not land. */
function switchOutcome(qc: QueryClient, tenantId: string): MessageKey | null {
  if (qc.getQueryState(queryKeys.activeContext)?.status === "error") return UNCONFIRMED;
  const read = qc.getQueryData<ContextRead>(queryKeys.activeContext);
  return read?.data?.active_tenant?.id === tenantId ? null : REFUSED;
}

export function useTenantSwitch(onSwitched: () => void) {
  const { switchTenant, context } = useActiveContextValue();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  // The tenant the switch landed on, until the shared context shows it.
  const [landed, setLanded] = useState<string | null>(null);
  const activeTenantId = context?.active_tenant?.id;

  useEffect(() => {
    if (landed === null || activeTenantId !== landed) return;
    setLanded(null);
    navigate("/");
  }, [landed, activeTenantId, navigate]);

  const toTenant = async (tenantId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    try {
      await switchTenant(tenantId);
      const why = switchOutcome(qc, tenantId);
      if (why) {
        setFailure(why);
        return;
      }
      onSwitched();
      setLanded(tenantId);
    } catch {
      setFailure(NO_ANSWER);
    } finally {
      inFlight.current = false;
    }
  };

  return { toTenant, failure, clearFailure: () => setFailure(null) };
}
