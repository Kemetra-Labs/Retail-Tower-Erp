/**
 * Audit scope prompt — shown when no active tenant (the RF-1 scope gate normally
 * precedes this; defensive). A precondition, not an error. Named *Like to avoid
 * implying it is the RF-5 OperatorScopePrompt.
 */
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import "../shell/surface.css";
import "./audit.css";

export function OperatorScopePromptLike(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <PageHeader title={t("audit.title")} />
      <div className="section-panel audit-results audit-prompt">
        <p className="scope-prompt">{t("audit.scopePrompt")}</p>
      </div>
    </div>
  );
}
