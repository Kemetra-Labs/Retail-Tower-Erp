import { useT } from "@/i18n";

/**
 * The decoration of the public night frame (owner decision 2026-11-08, board B):
 * a faint tower line drawing and the branch line under the form. Everything here
 * is `aria-hidden`, drawn from nothing the user needs, and never an icon, so the
 * one-icon-grammar test exempts this file and only this file: a real icon added
 * elsewhere in `src/auth/` still has to come from the registry.
 */

const SHIELD = "M12 3 4 6v6c0 4.5 3.2 7.4 8 9 4.8-1.6 8-4.5 8-9V6l-8-3Z";
const ROOK = "M9 17.5h6M9.8 17.5V12h4.4v5.5M9.2 12V9.5h1.3v1h1.1v-1h.8v1h1.1v-1h1.3V12";

/** A faint line drawing of the tower behind the form: ornament, never read. */
export function TowerSilhouette(): React.JSX.Element {
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

/** One branch: a small shield and its numeral. */
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
 * The line under the form: every branch, one tower. Decorative and generic, so it
 * is `aria-hidden`. The two numerals are illustrative, not data, and carry no
 * store term. The tagline is the owner's wording «كل الفروع تحت عينك»: it says
 * «الفروع» where UX-12 says a store is «المتجر», which is flagged as open in the
 * Arabic catalog and in the ux-pos-console skill, not settled here.
 */
export function BranchLine(): React.JSX.Element {
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
