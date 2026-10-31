/**
 * Operators scope prompt (SF5-1, FR-005-007). The pre-call active-tenant guard:
 * with no active tenant, RF-5 routes here instead of calling `listMembers`
 * (which has no precondition-401), or instead of letting a `createInvitation`
 * precondition-401 surface. A scope precondition, never a sign-out — the
 * operator resolves it via the RF-1 scope bar above.
 *
 * RT-1014 (v4.0): the page keeps its Ink band (it never changes with state, no
 * facts and no primary here) and the message sits in the same v4 panel as the
 * list's other states.
 */
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { useT } from "@/i18n";
import "../shell/surface.css";
import "./users.css";

export function OperatorScopePrompt(): React.JSX.Element {
  const t = useT();
  return (
    <div className="surface">
      <ListHeaderBand group={t("shell.nav.section.management")} title={t("operators.title")} />
      <div className="section-panel members-panel">
        <p className="scope-prompt">{t("operators.scopePrompt.message")}</p>
      </div>
    </div>
  );
}
