import { TowerMark } from "@/components/TowerMark";
import { useT } from "@/i18n";
import { LocaleSwitch } from "@/i18n/LocaleSwitch";
/**
 * RT-971 (canvas «تسجيل الدخول»): the frame of the public screens, sign-in and
 * accept-invitation. A form panel at the inline start (the brand lockup and the
 * language switch on top, the form centred, the audit note at the foot) and a
 * brand panel at the inline end. No card and no shadow: the form sits on the
 * page.
 *
 * The language switch is the shell's own `LocaleSwitch` with no user: the
 * choice is kept for this browser and the signed-in user's stored choice still
 * wins once the shell mounts (RT-399).
 *
 * The brand panel is decoration (`aria-hidden`): it repeats nothing a person
 * needs to sign in. Below 900px it is not shown, so the form comes first.
 * RT-807 (PW-5): it is flat Ink, with no watermark mark (DESIGN.md §12.1).
 */
import "./signin.css";

function BrandPanel(): React.JSX.Element {
  const t = useT();
  return (
    <div className="auth-brand-panel" aria-hidden="true">
      <div className="auth-brand-panel__flow">
        <span className="auth-brand-panel__flow-title">{t("auth.brand.flowTitle")}</span>
        <span className="auth-brand-panel__flow-steps">
          <span className="auth-brand-panel__step">{t("auth.brand.flowPos")}</span>
          <span className="auth-brand-panel__arrow">→</span>
          <span className="auth-brand-panel__step">{t("auth.brand.flowServer")}</span>
          <span className="auth-brand-panel__arrow">→</span>
          <bdi className="auth-brand-panel__step" dir="ltr">
            ERPNext
          </bdi>
        </span>
      </div>
      <div className="auth-brand-panel__copy">
        <strong className="auth-brand-panel__headline">{t("auth.brand.headline")}</strong>
        <span className="auth-brand-panel__body">{t("auth.brand.body")}</span>
      </div>
    </div>
  );
}

export function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="auth-page">
      <main className="auth-main">
        <div className="auth-top">
          <span className="auth-lockup">
            <span className="auth-lockup__tile">
              <TowerMark className="tower-mark" />
            </span>
            <span className="tower-lockup__word">Retail Tower OS</span>
          </span>
          <LocaleSwitch userId={undefined} />
        </div>
        <div className="auth-center">
          <div className="auth-form">{children}</div>
        </div>
        <p className="auth-foot">{t("auth.signIn.footer")}</p>
      </main>
      <BrandPanel />
    </div>
  );
}

/** The screen's title and its one muted line. */
export function AuthHead({
  title,
  subtitle,
}: Readonly<{ title: React.ReactNode; subtitle?: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="auth-head">
      <h1 className="auth-head__title">{title}</h1>
      {subtitle ? <p className="auth-head__sub">{subtitle}</p> : null}
    </div>
  );
}
