/**
 * RT-781 (RT-777 S2): the page body of a shell that can host a support session.
 * Once the session has expired the body is replaced by one calm state, so a
 * surface never shows its generic 403 error for what is a known, expected end.
 *
 *  - A tenant call refused with 403 `support_session_expired` swaps the body:
 *    that page is tenant-scoped and its data is gone.
 *  - Otherwise the children render, in the tenant shell and in `/platform`
 *    alike. RT-1468 (owner decision 2026-11-18): a platform admin works in any
 *    organization, with or without a session, and a session is no longer
 *    read-only. When the session runs out the admin keeps working; the bar's
 *    expired notice says new actions are no longer recorded under the session's
 *    purpose and ticket. The server still admits and records every request.
 *
 * With no session (a member-entered tenant, a plain user, a platform admin who
 * opened an organization directly) it renders its children untouched.
 */
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import { Link } from "react-router";
import { SupportSessionBar } from "./SupportSessionBar";
import type { SupportSessionController } from "./useSupportSession";
import { PLATFORM_HOME } from "./useSupportSession";
import "./support-session.css";

export function SupportSessionBarSlot({
  controller,
}: Readonly<{ controller: SupportSessionController | null }>): React.JSX.Element | null {
  return controller ? <SupportSessionBar controller={controller} /> : null;
}

export function SupportSessionExpiredBody(): React.JSX.Element {
  const t = useT();
  return (
    <div className="support-session-expired">
      <PageHeader
        title={t("platform.session.expiredBody.title")}
        subtitle={t("platform.session.expiredBody.body")}
      />
      <Link className="btn-secondary" to={PLATFORM_HOME}>
        {t("platform.session.expiredBody.action")}
      </Link>
    </div>
  );
}

export function SupportSessionBoundary({
  controller,
  children,
}: Readonly<{
  controller: SupportSessionController | null;
  children?: React.ReactNode;
}>): React.JSX.Element {
  return <>{controller?.refusedExpired ? <SupportSessionExpiredBody /> : children}</>;
}
