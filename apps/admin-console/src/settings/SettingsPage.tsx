import { TenantAiPlanSection } from "@/ai-entitlements/TenantAiPlanSection";
import { TenantBrandingLink } from "@/branding/TenantBrandingLink";
import { TenantPolicySection } from "@/cash-policy/TenantPolicySection";
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { TenantTrackedSellingSection } from "@/tracked-selling/TenantTrackedSellingSection";
import { Link } from "react-router";
import "../shell/surface.css";

/**
 * RF-7 (spec 016): the Settings destination at `/settings`, for the active
 * tenant. A thin hub, not a new settings system: it gathers the tenant
 * sections that already live on the tenant detail page — branding, the cash
 * variance policy, the AI plan and tracked selling — plus the account page,
 * so an admin finds them in one place instead of by deep link.
 *
 * Each section decides for itself what its role may see (and fetches nothing
 * for anyone else), exactly as on the tenant detail page; this page adds no
 * gate and no fetch of its own. Without an active tenant there is nothing to
 * configure, so the page points at the tenant list instead.
 */
export function SettingsPage(): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id;

  return (
    <div className="surface">
      <PageHeader title={t("settings.title")} subtitle={t("settings.sub")} />

      {!tenantId ? (
        <>
          <p>{t("settings.noTenant")}</p>
          <Link to="/tenants" className="btn-secondary">
            {t("shell.nav.tenants")}
          </Link>
        </>
      ) : (
        <>
          <TenantBrandingLink tenantId={tenantId} />
          <TenantPolicySection tenantId={tenantId} />
          <TenantAiPlanSection tenantId={tenantId} />
          <TenantTrackedSellingSection tenantId={tenantId} />
        </>
      )}

      <p>
        <Link to="/account" className="btn-secondary">
          {t("auth.account.title")}
        </Link>
      </p>
    </div>
  );
}
