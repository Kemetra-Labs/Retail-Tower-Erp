import { useT } from "@/i18n";
import { LocaleSwitch } from "@/i18n/LocaleSwitch";
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
 * sign-in. No component here restyles itself; they read the dark roles.
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

const SHIELD = "M12 3 4 6v6c0 4.5 3.2 7.4 8 9 4.8-1.6 8-4.5 8-9V6l-8-3Z";
const ROOK = "M9 17.5h6M9.8 17.5V12h4.4v5.5M9.2 12V9.5h1.3v1h1.1v-1h.8v1h1.1v-1h1.3V12";

/** A faint line drawing of the tower behind the form: ornament, never read. */
function TowerSilhouette(): React.JSX.Element {
  return (
    <svg className="auth-tower" viewBox="0 0 320 420" aria-hidden="true" focusable="false">
      <path d="M20 410H300" />
      <path d="M70 410 90 150H230L250 410" />
      <path d="M60 150H260L250 120H70Z" />
      <path d="M70 120V92H90V106H110V92H130V106H150V92H170V106H190V92H210V106H230V92H250V120" />
      <path d="M110 92V66M210 92V52" />
      <path d="M145 410V382a15 15 0 0 1 30 0V410" />
      <path d="M120 200V240M160 190V250M200 200V240" />
      <path d="M160 290 144 296V312c0 12 8 20 16 24 8-4 16-12 16-24V296Z" />
    </svg>
  );
}

/** One branch: a small shield and its label. */
function BranchNode({ label }: Readonly<{ label: string }>): React.JSX.Element {
  return (
    <span className="auth-branch__node">
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
        <path d={SHIELD} />
        <circle cx="12" cy="12" r="1.8" className="auth-branch__dot" />
      </svg>
      <span className="auth-branch__label">{label}</span>
    </span>
  );
}

/**
 * The line under the form: every branch, one tower. Decorative and generic (the
 * two numerals are illustrative, not data, and carry no store term: UX-12 says a
 * store is «المتجر», never «الفرع»), so it is `aria-hidden`.
 */
function BranchLine(): React.JSX.Element {
  const t = useT();
  return (
    <div className="auth-branch" aria-hidden="true">
      <div className="auth-branch__row">
        <BranchNode label="01" />
        <span className="auth-branch__link" />
        <span className="auth-branch__hub">
          <svg viewBox="0 0 24 24" width="52" height="52" aria-hidden="true" focusable="false">
            <path d={SHIELD} />
            <path d={ROOK} />
          </svg>
        </span>
        <span className="auth-branch__link" />
        <BranchNode label="02" />
      </div>
      <strong className="auth-branch__tagline">{t("auth.brand.tagline")}</strong>
    </div>
  );
}

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
