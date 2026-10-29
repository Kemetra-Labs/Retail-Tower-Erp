/**
 * RT-930 (RT-777 as-built P1-2): on the directory, why the operator landed here
 * after a renew or end answered 409 `support_session_absent`. A persistent
 * inline notice, never a toast (DESIGN.md rule 4): it stays until dismissed or
 * until another session starts.
 *
 * Polite, not an alert: nothing in the organization changed. Focus moves to it
 * when it appears, because the bar that held the pressed button is gone and a
 * live region inserted with its text already in it is often not read out.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  type SessionGone,
  clearSessionGone,
  getSessionGone,
  subscribeSessionGone,
} from "../session/sessionGone";
import type { TenantSummary } from "./directoryLogic";

/** The context name captured at the time, else the directory's, else the id as a last resort. */
function tenantNameOf(gone: SessionGone, tenants: readonly TenantSummary[]): string {
  return gone.tenantName ?? tenants.find((t) => t.id === gone.tenantId)?.name ?? gone.tenantId;
}

function Notice({
  gone,
  tenants,
}: Readonly<{ gone: SessionGone; tenants: readonly TenantSummary[] }>): React.JSX.Element {
  const t = useT();
  const ref = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  // <output> is the native polite status region (role="status").
  return (
    <output ref={ref} tabIndex={-1} className="rtc-alert rtc-alert--info platform-directory__gone">
      <span className="rtc-alert__msg">
        {t.rich(`platform.tenants.sessionGone.${gone.action}`, {
          tenant: <bdi>{tenantNameOf(gone, tenants)}</bdi>,
        })}
      </span>
      <span className="rtc-alert__action">
        <button type="button" className="btn-secondary" onClick={clearSessionGone}>
          {t("common.close")}
        </button>
      </span>
    </output>
  );
}

export function SessionGoneNotice({
  tenants,
}: Readonly<{ tenants: readonly TenantSummary[] }>): React.JSX.Element | null {
  const { context } = useActiveContextValue();
  const gone = useSyncExternalStore(subscribeSessionGone, getSessionGone, getSessionGone);
  const current = context?.support_session ?? null;
  // Another session is open now: the reason no longer applies.
  const movedOn = gone !== null && current !== null && current.id !== gone.sessionId;

  useEffect(() => {
    if (movedOn) clearSessionGone();
  }, [movedOn]);

  if (!gone || movedOn) return null;
  return <Notice key={gone.sessionId} gone={gone} tenants={tenants} />;
}
