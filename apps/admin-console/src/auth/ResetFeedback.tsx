/**
 * Shared submission lifecycle, Retry-After countdown, feedback banners and
 * submit-button for the public password-reset screens (`/forgot-password` and
 * `/reset-password`, RT-1497).
 */
import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { type MessageKey, useT } from "@/i18n";
import type { ErrorEnvelope } from "@/lib/backend-envelope";
import { useEffect, useState } from "react";
import { type ResetPhase, type ResetResolution, phaseFromResolution } from "./password-reset-flow";

export function useResetSubmission(fallbackErrorKey: MessageKey) {
  const [phase, setPhase] = useState<ResetPhase>({ status: "idle" });

  useEffect(() => {
    if (phase.status !== "rate-limited" || phase.retryAfterSeconds <= 0) return;
    const id = window.setTimeout(() => {
      setPhase((cur) => {
        if (cur.status !== "rate-limited") return cur;
        return cur.retryAfterSeconds <= 1
          ? { status: "idle" }
          : { ...cur, retryAfterSeconds: cur.retryAfterSeconds - 1 };
      });
    }, 1000);
    return () => window.clearTimeout(id);
  }, [phase]);

  async function run(
    action: () => Promise<{ status: number; error?: unknown; retryAfterSeconds?: number }>,
    classify: (input: {
      status: number;
      error?: ErrorEnvelope;
      retryAfterSeconds?: number;
    }) => ResetResolution,
  ): Promise<void> {
    setPhase({ status: "submitting" });
    try {
      const res = await action();
      setPhase(
        phaseFromResolution(
          classify({
            status: res.status,
            error: res.error as ErrorEnvelope | undefined,
            retryAfterSeconds: res.retryAfterSeconds,
          }),
        ),
      );
    } catch {
      setPhase({ status: "error", messageKey: fallbackErrorKey });
    }
  }

  const locked = phase.status === "rate-limited" && phase.retryAfterSeconds > 0;
  return { phase, setPhase, run, disabled: phase.status === "submitting" || locked };
}

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
  const locked = phase.status === "rate-limited" && phase.retryAfterSeconds > 0;
  const label =
    phase.status === "submitting"
      ? t(submittingKey)
      : locked
        ? t("auth.signIn.retryIn", { count: phase.retryAfterSeconds })
        : t(idleKey);

  return (
    <BusyButton
      className="btn-primary auth-submit"
      type="submit"
      busy={phase.status === "submitting"}
      disabled={locked}
    >
      {label}
    </BusyButton>
  );
}
