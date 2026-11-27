/**
 * Public forgot-password request screen (/forgot-password, RT-1497).
 *
 * Shares the RT-971 dark public frame (`AuthLayout`). Posts to
 * `POST /api/v1/auth/password-reset/request` which always responds 202 so the
 * UI renders one opaque confirmation message whether or not the address exists
 * (no account enumeration).
 */
import { Banner } from "@/components/Banner";
import { useT } from "@/i18n";
import { requestPasswordReset } from "@/lib/client";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { AuthHead, AuthLayout } from "./AuthLayout";
import { ResetErrorBanners, ResetSubmitButton } from "./ResetFeedback";
import {
  type ResetPhase,
  phaseFromResolution,
  resolvePasswordResetRequest,
  validateResetEmail,
} from "./password-reset-flow";

export function ForgotPassword(): React.JSX.Element {
  const t = useT();
  const [phase, setPhase] = useState<ResetPhase>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const rawEmail = (event.currentTarget.elements.namedItem("email") as HTMLInputElement).value;
    const validationError = validateResetEmail(rawEmail);
    if (validationError) {
      setPhase({ status: "error", messageKey: validationError });
      return;
    }

    setPhase({ status: "submitting" });
    const res = await requestPasswordReset({ email: rawEmail.trim() });
    setPhase(
      phaseFromResolution(
        resolvePasswordResetRequest({
          status: res.status,
          error: res.error as { error?: { request_id?: string } } | undefined,
          retryAfterSeconds: res.retryAfterSeconds,
        }),
      ),
    );
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

  const disabled = phase.status === "submitting" || phase.status === "rate-limited";

  return (
    <AuthLayout>
      <AuthHead
        title={t("auth.forgotPassword.title")}
        subtitle={t("auth.forgotPassword.subtitle")}
      />
      <ResetErrorBanners phase={phase} />
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
            aria-invalid={phase.status === "error"}
            required
          />
        </div>
        <ResetSubmitButton
          phase={phase}
          idleKey="auth.forgotPassword.submit"
          submittingKey="auth.forgotPassword.submitting"
        />
      </form>
      <p className="auth-note">
        <Link to="/signin">{t("auth.forgotPassword.backToSignIn")}</Link>
      </p>
    </AuthLayout>
  );
}
