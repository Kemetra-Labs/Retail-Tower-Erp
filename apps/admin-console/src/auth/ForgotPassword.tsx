/**
 * Public forgot-password request screen (/forgot-password, RT-1497).
 *
 * Shares the RT-971 dark public frame (`AuthLayout`). Posts to
 * `POST /api/v1/auth/password-reset/request` which always responds 202 so the
 * UI renders one opaque confirmation message whether or not the address exists
 * (no account enumeration).
 */
import { Banner } from "@/components/Banner";
import { BusyButton } from "@/components/BusyButton";
import { type MessageKey, useT } from "@/i18n";
import { requestPasswordReset } from "@/lib/client";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { AuthHead, AuthLayout } from "./AuthLayout";
import { resolvePasswordResetRequest, validateResetEmail } from "./password-reset-flow";

type Phase =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "sent" }
  | { status: "error"; messageKey: MessageKey; requestId?: string }
  | { status: "rate-limited"; retryAfterSeconds: number; requestId?: string };

function SubmitLabel({ phase }: Readonly<{ phase: Phase }>): React.JSX.Element {
  const t = useT();
  if (phase.status === "submitting") return <>{t("auth.forgotPassword.submitting")}</>;
  if (phase.status === "rate-limited") {
    return <>{t("auth.signIn.retryIn", { count: phase.retryAfterSeconds })}</>;
  }
  return <>{t("auth.forgotPassword.submit")}</>;
}

export function ForgotPassword(): React.JSX.Element {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ status: "idle" });

  const submitting = phase.status === "submitting";
  const rateLimited = phase.status === "rate-limited";
  const disabled = submitting || rateLimited;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const rawEmail = (form.elements.namedItem("email") as HTMLInputElement).value;
    const validationError = validateResetEmail(rawEmail);
    if (validationError) {
      setPhase({ status: "error", messageKey: validationError });
      return;
    }

    setPhase({ status: "submitting" });
    const res = await requestPasswordReset({ email: rawEmail.trim() });
    const resolution = resolvePasswordResetRequest({
      status: res.status,
      error: res.error as { error?: { request_id?: string } } | undefined,
      retryAfterSeconds: res.retryAfterSeconds,
    });

    if (resolution.kind === "sent") {
      setPhase({ status: "sent" });
      return;
    }
    if (resolution.kind === "rate-limited") {
      setPhase({
        status: "rate-limited",
        retryAfterSeconds: resolution.retryAfterSeconds,
        requestId: resolution.requestId,
      });
      return;
    }
    setPhase({
      status: "error",
      messageKey: resolution.messageKey,
      requestId: resolution.requestId,
    });
  }

  if (phase.status === "sent") {
    return (
      <AuthLayout>
        <AuthHead title={t("auth.forgotPassword.title")} />
        <Banner
          variant="success"
          title={t("auth.forgotPassword.sent.title")}
          message={t("auth.forgotPassword.sent.body")}
        />
        <p className="auth-note">
          <Link to="/signin">{t("auth.forgotPassword.backToSignIn")}</Link>
        </p>
        <p className="auth-note">
          <button type="button" className="btn-ghost" onClick={() => setPhase({ status: "idle" })}>
            {t("auth.forgotPassword.tryAnother")}
          </button>
        </p>
      </AuthLayout>
    );
  }

  const invalid = phase.status === "error";

  return (
    <AuthLayout>
      <AuthHead
        title={t("auth.forgotPassword.title")}
        subtitle={t("auth.forgotPassword.subtitle")}
      />

      {phase.status === "error" ? (
        <Banner variant="danger" message={t(phase.messageKey)} requestId={phase.requestId} />
      ) : null}
      {phase.status === "rate-limited" ? (
        <Banner
          variant="warning"
          message={t("auth.signIn.errors.rateLimited", { count: phase.retryAfterSeconds })}
          requestId={phase.requestId}
        />
      ) : null}

      <form className="auth-fields" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="email">{t("auth.signIn.email.label")}</label>
          <input
            className="input"
            id="email"
            name="email"
            type="email"
            dir="ltr"
            autoComplete="email"
            placeholder="name@company.com"
            disabled={disabled}
            aria-invalid={invalid}
            required
          />
        </div>
        <BusyButton
          className="btn-primary auth-submit"
          type="submit"
          busy={submitting}
          disabled={rateLimited}
        >
          <SubmitLabel phase={phase} />
        </BusyButton>
      </form>

      <p className="auth-note">
        <Link to="/signin">{t("auth.forgotPassword.backToSignIn")}</Link>
      </p>
    </AuthLayout>
  );
}
