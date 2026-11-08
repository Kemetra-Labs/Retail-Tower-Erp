import { RateLimitBanner } from "@/components/RateLimitBanner";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
/**
 * SF-2 authenticated app shell (T027; RF-2 T009/T010), on the Shell v3 frame
 * (RT-969, owner-approved canvas 2026-10-30): the sidebar at the inline start
 * holds the brand, the scope switcher and the grouped navigation; the 64px top
 * bar holds the Ctrl K navigator and the user menu (language and theme); the
 * routed surface renders in the content container. The frame every RF-2..RF-7
 * family attaches to. RT-270 (UX-09: no dead destinations): a destination is
 * listed only once it is built (`nav-model.ts`).
 */
import { canReadErpStatus } from "@/erp-status/erpStatusLogic";
import { roleKey, useT } from "@/i18n";
import {
  SupportSessionBarSlot,
  SupportSessionBoundary,
} from "@/platform/session/SupportSessionBoundary";
import { useSupportSession } from "@/platform/session/useSupportSession";
import { trackedSellingOn } from "@/tracked-selling/trackedSellingLogic";
import { useTrackedSellingQuery } from "@/tracked-selling/useTrackedSelling";
import { useTrackingSummary } from "@/tracking/useTracking";
import { useShellNavigator } from "./Navigator";
import { ScopeHeader } from "./ScopeHeader";
import { NavEntries, ShellContent, ShellSidebar, ShellTopBar, SkipLink } from "./ShellFrame";
import { ShellMenuDrawer, useShellMenu, useShellMenuId } from "./ShellMenu";
import { tenantNav } from "./nav-model";

export interface AppShellProps {
  onSignOut: () => void | Promise<void>;
  children?: React.ReactNode;
}

export function AppShell({ onSignOut, children }: Readonly<AppShellProps>): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const supportSession = useSupportSession();
  // RT-781: inside a support session the shell shows no tenant surface, scope
  // switcher or tenant navigation: no write control by construction (a UI
  // safeguard, not a security control).
  const inSession = supportSession !== null;
  const user = context?.user;
  const roleCode = context?.active_role_code;
  const roleLabel = roleCode ? t(roleKey(roleCode)) : undefined;
  // RT-455 (TR-6): the tracking entry waits for the server's summary.
  const hasTrackedProducts = useTrackingSummary(
    context?.active_tenant?.id ?? null,
    roleCode,
    !inSession,
  );
  // RT-455 part 1 (OD-T4): and only while the tenant's tracked-selling switch is on.
  const trackedSelling = useTrackedSellingQuery(
    context?.active_tenant?.id ?? null,
    roleCode,
    !inSession,
  );
  const groups = tenantNav(roleCode, inSession, {
    hasTrackedProducts,
    trackedSellingOn: trackedSellingOn(trackedSelling.data),
  });
  const menu = useShellMenu();
  const menuId = useShellMenuId();
  const navigator = useShellNavigator();

  return (
    <div className={inSession ? "shell shell--session" : "shell"}>
      <SkipLink />
      <ShellTopBar
        menu={menu}
        menuId={menuId}
        navigator={navigator}
        groups={groups}
        withStores={!inSession}
        user={user}
        roleLabel={roleLabel}
        accountLink={!inSession}
      />

      {/* RT-781: the support-session bar, only for a session-entered tenant. */}
      <div className="shell-session-slot">
        <SupportSessionBarSlot controller={supportSession} />
      </div>
      <ShellSidebar
        navLabel={t("shell.nav.label")}
        tag={t("app.productTag")}
        groups={groups}
        scope={inSession ? null : <ScopeHeader />}
        // A support session shows no tenant surface and sends no tenant request (RT-781).
        systemStatus={!inSession && canReadErpStatus(roleCode)}
        onSignOut={onSignOut}
      />

      <ShellMenuDrawer
        menu={menu}
        drawerId={menuId}
        user={user}
        roleLabel={roleLabel}
        navLabel={t("shell.nav.label")}
        onSignOut={onSignOut}
        renderNav={(onNavigate) => <NavEntries groups={groups} onNavigate={onNavigate} />}
      />

      <ShellContent dirtyScope>
        {/* RT-621: any 429 shows here, above the surface, without blocking it. */}
        <RateLimitBanner />
        <SupportSessionBoundary controller={supportSession} tenantShell>
          {children}
        </SupportSessionBoundary>
      </ShellContent>
    </div>
  );
}
