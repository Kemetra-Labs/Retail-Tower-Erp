/**
 * RT-969 (Shell v3): the top bar's user block. Avatar, name and role, and a
 * disclosure that holds the language (RT-399) and theme (RT-398) switches.
 * Both switches render unchanged, so their per-user persistence and their
 * constant labels stay as they are.
 *
 * A disclosure, not a `role="menu"`: the panel holds a toggle button
 * (`aria-pressed`) and a language button, which are not menu items. Escape
 * closes it back to its button; a press outside closes it.
 *
 * The button is named by the name-and-role text through `aria-labelledby`, so
 * it keeps that name at the compact width, where the text is not drawn.
 *
 * The switches mount only while the panel is open, so the user's stored
 * language and theme are adopted here, when the shell mounts (RT-398/399).
 *
 * RT-807 (PW-1): under the preferences, a link to the «حسابي» page, where the
 * password is changed. Following it closes the panel.
 */
import { Icon } from "@/components/icons/Icon";
import { useT } from "@/i18n";
import { LocaleSwitch, useUserLocale } from "@/i18n/LocaleSwitch";
import { ThemeToggle } from "@/theme/ThemeToggle";
import { useTheme } from "@/theme/useTheme";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";

export interface UserMenuProps {
  user: { id?: string; display_name?: string | null; email?: string | null };
  roleLabel?: string;
}

/** Up to two initials from the name, or from the email's local part. */
function initialsOf(user: UserMenuProps["user"]): string {
  return (user.display_name ?? user.email ?? "?")
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function UserMenu({ user, roleLabel }: Readonly<UserMenuProps>): React.JSX.Element {
  const t = useT();
  // Restore this user's own language and theme now, not when the panel opens.
  useUserLocale(user.id);
  useTheme(user.id);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId().replaceAll(":", "");
  const nameId = `user-menu-name-${id}`;
  const panelId = `user-menu-panel-${id}`;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const closeOnEscape = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="user-menu" onKeyDown={closeOnEscape}>
      <button
        ref={buttonRef}
        type="button"
        className="topbar__user"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={nameId}
        onClick={(e) => {
          e.currentTarget.focus();
          setOpen((v) => !v);
        }}
      >
        <span className="topbar__avatar" aria-hidden="true">
          {initialsOf(user)}
        </span>
        <span id={nameId} className="topbar__name">
          <bdi>{user.display_name ?? user.email}</bdi>
          {roleLabel ? <small>{roleLabel}</small> : null}
        </span>
        <Icon name="disclosure" size="sm" className="topbar__caret" />
      </button>
      {open ? (
        <div id={panelId} className="user-menu__panel">
          <fieldset className="user-menu__prefs">
            <legend className="user-menu__legend">{t("shell.userMenu.prefs")}</legend>
            <LocaleSwitch userId={user.id} />
            <ThemeToggle userId={user.id} />
          </fieldset>
          <Link to="/account" className="btn-ghost user-menu__link" onClick={() => setOpen(false)}>
            {t("shell.userMenu.account")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
