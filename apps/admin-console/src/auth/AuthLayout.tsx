import { useT } from "@/i18n";
import { LocaleSwitch } from "@/i18n/LocaleSwitch";
import { BranchLine, TowerSilhouette } from "./AuthOrnament";
import logoUrl from "./assets/logo-shield.webp?no-inline";
import artUrl from "./assets/signin-art.webp?no-inline";
import "./signin.css";

/**
 * The frame of the public screens, sign-in and accept-invitation (RT-971, then
 * the "night" frame, owner decision 2026-11-08, board B). A form panel at the
 * inline start (the logo lockup and the language switch on top, the form
 * centred, the audit note at the foot) and the artwork at the inline end.
 *
 * The frame is always dark. `[data-theme="dark"]` is an attribute selector, so
 * setting it on this wrapper alone remaps every role token (and the mint primary
 * button with Ink text) in both themes: the user's theme is not known before
 * sign-in. Components read the remapped roles. `PasswordInput` is shared with the
 * signed-in Account page, so its rules in `signin.css` must keep using those
 * roles and never the Ink-only ones.
 *
 * The artwork is decoration (`aria-hidden`, empty alt): the wordmark beside the
 * form already names the product. It and the logo are real same-origin files,
 * imported with `?no-inline`: the Caddy CSP is `default-src 'self'`, so a small
 * file that Vite inlined as a `data:` URI would be blocked in production.
 * Below 900px the artwork is not shown, so the form comes first.
 *
 * The language switch is the shell's own `LocaleSwitch` with no user: the choice
 * is kept for this browser and the signed-in user's stored choice still wins once
 * the shell mounts (RT-399).
 */

function ArtPanel(): React.JSX.Element {
  return (
    <div className="auth-art" aria-hidden="true">
      <img
        className="auth-art__img"
        src={artUrl}
        alt=""
        width={1008}
        height={1792}
        decoding="async"
      />
    </div>
  );
}

export function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="auth-page" data-theme="dark">
      <main className="auth-main">
        <TowerSilhouette />
        <div className="auth-top">
          <span className="auth-lockup">
            <span className="auth-lockup__tile">
              <img className="auth-lockup__logo" src={logoUrl} alt="" width={256} height={256} />
            </span>
            <span className="auth-lockup__word">Retail Tower OS</span>
          </span>
          <LocaleSwitch userId={undefined} />
        </div>
        <div className="auth-center">
          <div className="auth-form">
            {children}
            <BranchLine />
          </div>
        </div>
        <p className="auth-foot">{t("auth.signIn.footer")}</p>
      </main>
      <ArtPanel />
    </div>
  );
}

/** The screen's title, its one muted line and, on sign-in, a small greeting above. */
export function AuthHead({
  title,
  subtitle,
  eyebrow,
}: Readonly<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="auth-head">
      {eyebrow ? <span className="auth-head__eyebrow">{eyebrow}</span> : null}
      <h1 className="auth-head__title">{title}</h1>
      {subtitle ? <p className="auth-head__sub">{subtitle}</p> : null}
    </div>
  );
}
