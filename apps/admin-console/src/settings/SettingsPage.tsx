import { TenantAiPlanSection } from "@/ai-entitlements/TenantAiPlanSection";
import { TenantBrandingLink } from "@/branding/TenantBrandingLink";
import { TenantPolicySection } from "@/cash-policy/TenantPolicySection";
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { TenantTrackedSellingSection } from "@/tracked-selling/TenantTrackedSellingSection";
import { Link } from "react-router";
import "../shell/surface.css";
import "./settings.css";

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
 *
 * Modern concept (Settings & Devices): the hub is a row of unified DESIGN v4
 * cards (rule 5) with the wider surface spacing (rule 1). The two destinations
 * the page already had — the branding page and the account page — sit in one
 * quick-links bar at the top, mirroring the Overview's quick-actions bar; the
 * three inline sections sit each in its own card below, unchanged inside
 * (they are shared with the tenant detail page, so their bodies are not
 * restyled here). The page performs no action of its own and makes no read of
 * its own, so it carries no smart insight (rule 4 needs a read the page
 * already makes; the sections read independently) and no new toggle.
 */
export function SettingsPage(): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id;

  return (
    <div className="surface settings-surface">
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
          <nav className="section-panel settings-quick" aria-labelledby="settings-quick-title">
            <div className="section-panel__head">
              <h2 id="settings-quick-title" className="section-panel__title">
                {t("settings.quick.title")}
              </h2>
            </div>
            <div className="settings-quick__links">
              <TenantBrandingLink tenantId={tenantId} />
              <p>
                <Link to="/account" className="btn-secondary">
                  {t("auth.account.title")}
                </Link>
              </p>
            </div>
          </nav>

          <div className="section-panel settings-card">
            <TenantPolicySection tenantId={tenantId} />
          </div>
          <div className="section-panel settings-card">
            <TenantAiPlanSection tenantId={tenantId} />
          </div>
          <div className="section-panel settings-card">
            <TenantTrackedSellingSection tenantId={tenantId} />
          </div>
        </>
      )}

      {!tenantId ? (
        <p>
          <Link to="/account" className="btn-secondary">
            {t("auth.account.title")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
