/**
 * Tenant-less shell for `/platform` (RT-780, RT-777 §2), on the Shell v3 frame
 * (RT-969): a sidebar with the platform destinations only (shell rule 7), the
 * top bar with the Ctrl K navigator over those destinations and the user menu,
 * and the support-session bar (RT-781, RT-777 S2), which renders only while the
 * context carries a support session. It has no scope switcher: nothing here
 * switches the active tenant, and the navigator offers no store.
 */
import { RateLimitBanner } from "@/components/RateLimitBanner";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import { useShellNavigator } from "@/shell/Navigator";
import { NavEntries, ShellContent, ShellSidebar, ShellTopBar, SkipLink } from "@/shell/ShellFrame";
import { ShellMenuDrawer, useShellMenu, useShellMenuId } from "@/shell/ShellMenu";
import { PLATFORM_NAV } from "@/shell/nav-model";
import { RateLimitClaimProvider, useRateLimitClaims } from "./rateLimitOwner";
import { SupportSessionBarSlot, SupportSessionBoundary } from "./session/SupportSessionBoundary";
import { useSupportSession } from "./session/useSupportSession";
import "./platform.css";

export interface PlatformShellProps {
  onSignOut: () => void | Promise<void>;
  children?: React.ReactNode;
}

export function PlatformShell({
  onSignOut,
  children,
}: Readonly<PlatformShellProps>): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const supportSession = useSupportSession();
  const { claimedSeqs, claim } = useRateLimitClaims();
  const user = context?.user;
  const menu = useShellMenu();
  const menuId = useShellMenuId();
  const navigator = useShellNavigator();

  return (
    <div className="shell platform-shell">
      <SkipLink />
      <ShellTopBar
        menu={menu}
        menuId={menuId}
        navigator={navigator}
        groups={PLATFORM_NAV}
        withStores={false}
        user={user}
      />

      <div className="platform-session-slot" data-slot="support-session-bar">
        <SupportSessionBarSlot controller={supportSession} />
      </div>
      <ShellSidebar
        navLabel={t("platform.nav.label")}
        tag={t("platform.label")}
        groups={PLATFORM_NAV}
        onSignOut={onSignOut}
      />

      <ShellMenuDrawer
        menu={menu}
        drawerId={menuId}
        user={user}
        navLabel={t("platform.nav.label")}
        onSignOut={onSignOut}
        renderNav={(onNavigate) => <NavEntries groups={PLATFORM_NAV} onNavigate={onNavigate} />}
      />

      <ShellContent>
        {/* RT-931: a surface that shows its own 429 claims it; the shared banner skips that one. */}
        <RateLimitBanner claimedSeqs={claimedSeqs} />
        <RateLimitClaimProvider value={claim}>
          <SupportSessionBoundary controller={supportSession}>{children}</SupportSessionBoundary>
        </RateLimitClaimProvider>
      </ShellContent>
    </div>
  );
}
