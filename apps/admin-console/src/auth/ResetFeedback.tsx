/**
 * Shared feedback banners and submit-button label for the public password-reset
 * screens (`/forgot-password` and `/reset-password`, RT-1497).
 */
import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { type MessageKey, useT } from "@/i18n";
import type { ResetPhase } from "./password-reset-flow";

export function ResetErrorBanners({
  phase,
}: Readonly<{ phase: ResetPhase }>): React.JSX.Element | null {
  const t = useT();
  if (phase.status === "error") {
    return <Banner variant="danger" message={t(phase.messageKey)} requestId={phase.requestId} />;
  }
  if (phase.status === "rate-limited") {
    return (
      <Banner
        variant="warning"
        message={t("auth.signIn.errors.rateLimited", { count: phase.retryAfterSeconds })}
        requestId={phase.requestId}
      />
    );
  }
  return null;
}

export function ResetSubmitButton({
  phase,
  idleKey,
  submittingKey,
}: Readonly<{
  phase: ResetPhase;
  idleKey: MessageKey;
  submittingKey: MessageKey;
}>): React.JSX.Element {
  const t = useT();
  const label =
    phase.status === "submitting"
      ? t(submittingKey)
      : phase.status === "rate-limited"
        ? t("auth.signIn.retryIn", { count: phase.retryAfterSeconds })
        : t(idleKey);

  return (
    <BusyButton
      className="btn-primary auth-submit"
      type="submit"
      busy={phase.status === "submitting"}
      disabled={phase.status === "rate-limited"}
    >
      {label}
    </BusyButton>
  );
}
