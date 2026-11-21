/**
 * RT-1541: every state of the panel that is not a loaded answer (RT-1526 §5.2).
 *
 * Refusals, declines and unavailability are persistent text, never a toast (UX-11.11), written
 * What -> Safety -> Action. Copy comes from the Console's catalogue by CODE; raw server text is
 * never shown (O-7). A 404 is one non-disclosing message: it never says a store does not exist,
 * and never says "outside your access" either, because the same 404 covers a role, a platform
 * admin and an unknown store. A reference (`request_id`) is shown only for a 400/5xx that carries
 * one, exact and left-to-right (Banner).
 */
import { Banner } from "@/components/Banner";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n";
import { AnswerView } from "./AnswerView";
import {
  type ExplainOutcome,
  REFUSAL_COPY,
  type StoreOption,
  unavailableView,
} from "./managerSalesLogic";

function Retry({ onRetry }: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  const t = useT();
  return (
    <button type="button" className="btn-secondary" onClick={onRetry}>
      {t("aiManagerSales.retry")}
    </button>
  );
}

function Message({
  messageKey,
  hintKey,
  tone = "info",
}: Readonly<{
  messageKey: MessageKey;
  hintKey?: MessageKey;
  tone?: "info" | "warning";
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className={`ams-message ams-message--${tone}`}>
      <p className="ams-message__text">{t(messageKey)}</p>
      {hintKey ? <p className="ams-message__hint">{t(hintKey)}</p> : null}
    </div>
  );
}

const CLARIFY_COPY = {
  range: "aiManagerSales.clarify.range",
  "scope-too-large": "aiManagerSales.clarify.scopeTooLarge",
  invalid: "aiManagerSales.clarify.invalid",
} as const satisfies Record<string, MessageKey>;

export function OutcomeView({
  outcome,
  role,
  stores,
  onRetry,
}: Readonly<{
  outcome: ExplainOutcome;
  role: string;
  stores: readonly StoreOption[];
  onRetry: () => void;
}>): React.JSX.Element {
  const t = useT();
  switch (outcome.kind) {
    case "answer":
      return <AnswerView answer={outcome.answer} stores={stores} />;
    case "refusal":
      return <Message messageKey={REFUSAL_COPY[outcome.code]} />;
    case "unavailable": {
      const view = unavailableView(outcome.code, role);
      if (view.tone === "error") {
        return (
          <Banner
            variant="danger"
            message={t(view.messageKey)}
            action={<Retry onRetry={onRetry} />}
          />
        );
      }
      return <Message messageKey={view.messageKey} />;
    }
    case "clarify":
      return (
        <Banner
          variant="warning"
          message={t(CLARIFY_COPY[outcome.reason])}
          requestId={outcome.requestId}
        />
      );
    case "denied":
      return <Message messageKey="aiManagerSales.denied" hintKey="aiManagerSales.deniedHint" />;
    case "session":
      return <Message messageKey="aiManagerSales.error.session" tone="warning" />;
    case "rate-limited":
      return (
        <div className="ams-message-stack">
          <Message
            messageKey="aiManagerSales.error.rateLimited"
            hintKey="aiManagerSales.error.rateLimitedHint"
            tone="warning"
          />
          <Retry onRetry={onRetry} />
        </div>
      );
    default:
      return (
        <Banner
          variant="danger"
          message={t("aiManagerSales.error.generic")}
          requestId={outcome.requestId}
          action={<Retry onRetry={onRetry} />}
        />
      );
  }
}
