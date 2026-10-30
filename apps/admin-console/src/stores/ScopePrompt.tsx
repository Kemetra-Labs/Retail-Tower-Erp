/**
 * Scope prompt (Phase 4, OQ-4). Rendered by the store surfaces when there is no
 * active tenant (pre-gate) or on a residual scope-`401`. It is a scope
 * precondition, NOT a session-expiry: it must never trigger RF-1's sign-out.
 * The operator resolves scope by switching tenant via the RF-1 scope header
 * (the scope bar above this content), so this prompt points there rather than
 * duplicating the chooser.
 */
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import "../shell/surface.css";

export function ScopePrompt(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <PageHeader title={t("stores.list.title")} />
      <p className="scope-prompt">{t("stores.scope.prompt")}</p>
    </div>
  );
}
