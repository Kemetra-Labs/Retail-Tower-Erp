/**
 * Public forgot-password request screen (/forgot-password, RT-1497).
 *
 * Shares the RT-971 dark public frame (`AuthLayout`). Posts to
 * `POST /api/v1/auth/password-reset/request` which always responds 202 so the
 * UI renders one opaque confirmation message whether or not the address exists
 * (no account enumeration).
 */
import { useT } from "@/i18n";
import { requestPasswordReset } from "@/lib/client";
import type { FormEvent } from "react";
import { Link } from "react-router";
import { AuthHead, AuthLayout } from "./AuthLayout";
import {
  AuthEmailField,
  ResetErrorBanners,
  ResetSubmitButton,
  ResetSuccessView,
  useResetSubmission,
} from "./ResetFeedback";
import { resolvePasswordResetRequest, validateResetEmail } from "./password-reset-flow";

export function ForgotPassword(): React.JSX.Element {
  const t = useT();
  const { phase, setPhase, run, disabled } = useResetSubmission(
    "auth.forgotPassword.errors.failed",
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const rawEmail = (event.currentTarget.elements.namedItem("email") as HTMLInputElement).value;
    const validationError = validateResetEmail(rawEmail);
    if (validationError) {
      setPhase({ status: "error", messageKey: validationError });
      return;
    }
    await run(() => requestPasswordReset({ email: rawEmail.trim() }), resolvePasswordResetRequest);
  }

  if (phase.status === "sent") {
    return (
      <ResetSuccessView
        headTitleKey="auth.forgotPassword.title"
        bannerTitleKey="auth.forgotPassword.sent.title"
        bannerBodyKey="auth.forgotPassword.sent.body"
        signInLinkKey="auth.forgotPassword.backToSignIn"
        extra={
          <p className="auth-note">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPhase({ status: "idle" })}
            >
              {t("auth.forgotPassword.tryAnother")}
            </button>
          </p>
        }
      />
    );
  }

  return (
    <AuthLayout>
      <AuthHead
        title={t("auth.forgotPassword.title")}
        subtitle={t("auth.forgotPassword.subtitle")}
      />
      <ResetErrorBanners phase={phase} />
      <form className="auth-fields" onSubmit={handleSubmit} noValidate>
        <AuthEmailField
          autoComplete="email"
          disabled={disabled}
          invalid={phase.status === "error"}
        />
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
