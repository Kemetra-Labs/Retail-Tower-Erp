/**
 * RT-474 entry on the tenant page: a link to «هوية المؤسسة», rendered only for
 * an owner / tenant_admin of that (the active) tenant, like the cash policy and
 * AI plan sections beside it. It is a link to its own route, not a section,
 * because the two previews need the full width (brief §2).
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { Link } from "react-router";
import { canManageLogo } from "./brandingAccess";

export function TenantBrandingLink({
  tenantId,
}: Readonly<{ tenantId: string }>): React.JSX.Element | null {
  const t = useT();
  const { context } = useActiveContextValue();
  const allowed =
    canManageLogo(context?.active_role_code) && context?.active_tenant?.id === tenantId;
  if (!allowed) return null;
  return (
    <p className="logo-entry">
      <Link to={`/tenants/${tenantId}/branding`} className="btn-secondary">
        {t("branding.title")}
      </Link>
    </p>
  );
}
