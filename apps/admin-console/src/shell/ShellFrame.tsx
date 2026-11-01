/**
 * RT-969 (Shell v3, "Daylight Commerce"): the frame both shells share, the
 * tenant `AppShell` and the platform `PlatformShell`.
 *
 * - `ShellSidebar` (260px, inline start): brand lockup, an optional scope slot
 *   (the tenant shell's scope switcher), then the grouped navigation and
 *   sign-out. At ≤768px (RT-825) only the scope slot stays, as the row under
 *   the top bar; navigation moves to the menu drawer.
 * - `ShellTopBar` (64px): the compact menu button and mark, the Ctrl K
 *   navigator, and the user menu.
 * - `ShellContent`: the content container (max 1240px) the routed page renders
 *   in, with the page header first (`PageHeader`).
 *
 * Operational chrome with no backing (notifications, system status) is not
 * rendered: a dead control reads as a fake to an operator (PRODUCT.md P4/P5).
 */
import { TowerMark } from "@/components/TowerMark";
import { Icon } from "@/components/icons/Icon";
import { useT } from "@/i18n";
import { useId } from "react";
import { NavLink } from "react-router";
import { BrandMark } from "./BrandMark";
import { type ShellNavigator, ShellNavigatorControl } from "./Navigator";
import { type ShellMenu, ShellMenuButton } from "./ShellMenu";
import { UserMenu, type UserMenuProps } from "./UserMenu";
import type { NavGroup } from "./nav-model";
import "./app-shell.css";

const entryClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? "nav-entry nav-entry--active" : "nav-entry nav-entry--link";

/**
 * The grouped destinations, rendered for the sidebar and again for the
 * compact-shell drawer (RT-825), so both list exactly the same entries.
 * `onNavigate` lets the drawer close on any choice, the current page included.
 */
export function NavEntries({
  groups,
  onNavigate,
}: Readonly<{ groups: readonly NavGroup[]; onNavigate?: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      {groups.map((group) => (
        <div key={group.id} className="nav-group">
          {group.heading ? <div className="nav-section">{t(group.heading)}</div> : null}
          {group.entries.map((entry) => (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={entry.end}
              className={entryClass}
              onClick={onNavigate}
            >
              <Icon name={entry.icon} className="nav-entry__icon" />
              <span className="nav-entry__label">{t(entry.label)}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}

export interface ShellSidebarProps {
  navLabel: string;
  /** The product label under the brand word ("Console", "Platform"). */
  tag: string;
  groups: readonly NavGroup[];
  /** The scope switcher, in the tenant shell. */
  scope?: React.ReactNode;
  /** RT-993: the system-status block, in the tenant shell only (§12.6). */
  systemStatus?: boolean;
  onSignOut: () => void | Promise<void>;
}

/**
 * RT-993 the sidebar system-status block (DESIGN.md §12.6). No read serves a
 * system status to the Console yet (RT-1056), so by owner decision 2026-11-01
 * (RT-993 comment 15088, amending §12.8.6) it renders its frame with a clear
 * «قريبًا» and claims no state.
 */
function SystemStatus(): React.JSX.Element {
  const t = useT();
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of read-only text, not form controls; a fieldset would announce a form grouping.
    <div className="sidebar__status" role="group" aria-labelledby={titleId}>
      <span id={titleId} className="sidebar__status-title">
        {t("shell.status.title")}
      </span>
      <span className="sidebar__status-soon">{t("shell.status.soon")}</span>
    </div>
  );
}

export function ShellSidebar({
  navLabel,
  tag,
  groups,
  scope,
  systemStatus = false,
  onSignOut,
}: Readonly<ShellSidebarProps>): React.JSX.Element {
  const t = useT();
  return (
    // A labelled landmark, so the brand and the scope switcher sit in one too.
    <aside className="sidebar" aria-label={t("shell.sidebar.label")}>
      <div className="sidebar__inner">
        <span className="sidebar__brand">
          <BrandMark />
          <span className="sidebar__brand-text">
            <span className="tower-lockup__word">Retail Tower OS</span>
            <span className="tower-lockup__tag">{tag}</span>
          </span>
        </span>
        {scope}
        <nav className="sidebar__nav" aria-label={navLabel}>
          <NavEntries groups={groups} />
          <div className="sidebar__spacer" />
          {systemStatus ? <SystemStatus /> : null}
          <button type="button" className="nav-entry nav-signout" onClick={() => void onSignOut()}>
            <Icon name="signOut" className="nav-entry__icon" />
            <span className="nav-entry__label">{t("shell.signOut")}</span>
          </button>
        </nav>
      </div>
    </aside>
  );
}

export interface ShellTopBarProps {
  menu: ShellMenu;
  menuId: string;
  navigator: ShellNavigator;
  groups: readonly NavGroup[];
  withStores: boolean;
  user: UserMenuProps["user"] | undefined;
  roleLabel?: string;
  /** RT-807: the user menu's «حسابي» link (tenant shell only). */
  accountLink?: boolean;
}

export function ShellTopBar({
  menu,
  menuId,
  navigator,
  groups,
  withStores,
  user,
  roleLabel,
  accountLink,
}: Readonly<ShellTopBarProps>): React.JSX.Element {
  return (
    <header className="topbar">
      <ShellMenuButton menu={menu} drawerId={menuId} />
      {/* The brand lives in the sidebar; at the compact width it is here. */}
      <span className="topbar__brand">
        <TowerMark className="tower-mark" />
      </span>
      <ShellNavigatorControl navigator={navigator} groups={groups} withStores={withStores} />
      <div className="topbar__spacer" />
      {user ? <UserMenu user={user} roleLabel={roleLabel} accountLink={accountLink} /> : null}
    </header>
  );
}

/** The page's own content, for the skip link (RT-963). */
export const MAIN_ID = "main-content";

/**
 * RT-963 (WCAG 2.4.1): the first Tab stop of the shell, hidden until focused,
 * jumps past the top bar and the sidebar to the page.
 */
export function SkipLink(): React.JSX.Element {
  const t = useT();
  return (
    <a className="skip-link" href={`#${MAIN_ID}`}>
      {t("shell.skipToContent")}
    </a>
  );
}

/** The content container: one measure, the page header first, then the page. */
export function ShellContent({
  dirtyScope,
  children,
}: Readonly<{ dirtyScope?: boolean; children: React.ReactNode }>): React.JSX.Element {
  return (
    // data-dirty-scope: forms edited in here count as unsaved work (RT-268).
    <main
      id={MAIN_ID}
      // The skip link's target: focusable by script and link, never a Tab stop.
      tabIndex={-1}
      className="content"
      data-dirty-scope={dirtyScope ? "" : undefined}
    >
      <div className="content__frame">{children}</div>
    </main>
  );
}
