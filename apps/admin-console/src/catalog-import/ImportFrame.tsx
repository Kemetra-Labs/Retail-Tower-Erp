/**
 * RT-1509: the frame every import page shares: the page header, the seven-step strip, the step's
 * `h2` (the focus target on a step change, `tabindex="-1"`) and a polite status line that names the
 * step («الخطوة 4 من 7: المراجعة»). No toast, no extra alert (UX-11.20).
 *
 * The workspace is a dedicated page, not a drawer (UX-05.27). A role the API does not admit gets the
 * non-disclosing "not available" state and no form; the server stays authoritative.
 */
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import { useReadScope } from "@/lib/server-read";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { ImportStepper, stepName, stepNumber } from "./ImportStepper";
import { type ImportStep, canImportCatalog } from "./catalogImportLogic";
import "../shell/surface.css";
import "./catalog-import.css";

export function ImportFrame({
  step,
  currentFact,
  needsValidation,
  children,
}: Readonly<{
  step: ImportStep;
  currentFact?: string;
  needsValidation?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const { role } = useReadScope();
  const heading = useRef<HTMLHeadingElement>(null);
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);

  // A move to another step is a path change: the page header moves focus to the page's `h1` for it,
  // and this parent effect runs after the header's in the same commit, so the step's heading wins
  // (UX-11.20). The publish modal is not a path: it owns focus while open and gives it back.
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    heading.current?.focus();
  }, [pathname]);

  if (!canImportCatalog(role)) {
    return (
      <div className="surface">
        <PageHeader title={t("catalogImport.title")} />
        <p>{t("catalogImport.error.notAvailable")}</p>
      </div>
    );
  }
  return (
    <div className="surface">
      <PageHeader title={t("catalogImport.title")} subtitle={t("catalogImport.crumb")} />
      <ImportStepper current={step} currentFact={currentFact} needsValidation={needsValidation} />
      <h2 ref={heading} tabIndex={-1} className="import-step__title">
        {t(stepName(step))}
      </h2>
      <output className="sr-only" aria-live="polite">
        {t("catalogImport.stepper.announce", { n: stepNumber(step), name: t(stepName(step)) })}
      </output>
      {children}
    </div>
  );
}

/** A way back to the upload step, for the states with nothing to continue. */
export function BackToUpload(): React.JSX.Element {
  const t = useT();
  return (
    <p>
      <Link to="/catalog/import" className="btn-ghost">
        {t("catalogImport.back")}
      </Link>
    </p>
  );
}
