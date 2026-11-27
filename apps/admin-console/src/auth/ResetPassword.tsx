/**
 * Public set-new-password screen (/reset-password, RT-1497).
 *
 * Sibling of `/signin` and `/accept-invitation` on the RT-971 dark public
 * frame (`AuthLayout`). Reads the recovery token from `?t=` (Descope) or
 * `?token=` (native) and posts `{ token, new_password }` to
 * `POST /api/v1/auth/password-reset/confirm`. Passwords are sent verbatim
 * (no trimming or Unicode normalization, RT-153).
 */
import { Banner } from "@/components/Banner";
import { useT } from "@/i18n";
import { confirmPasswordReset } from "@/lib/client";
import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AuthHead, AuthLayout } from "./AuthLayout";
import { PasswordInput } from "./PasswordInput";
import { ResetErrorBanners, ResetSubmitButton } from "./ResetFeedback";
import {
  type ResetPhase,
  extractResetToken,
  phaseFromResolution,
  resolvePasswordResetConfirm,
  validateResetPasswordForm,
} from "./password-reset-flow";

export function ResetPassword(): React.JSX.Element {
  const [params] = useSearchParams();
  const token = extractResetToken(params);
  const t = useT();
  const [phase, setPhase] = useState<ResetPhase>({ status: "idle" });

  if (token.length === 0) {
    return (
      <AuthLayout>
        <AuthHead title={t("auth.resetPassword.titleInvalid")} />
        <Banner variant="danger" message={t("auth.resetPassword.errors.missingLink")} />
        <p className="auth-note">
          <Link to="/forgot-password">{t("auth.resetPassword.requestNewLink")}</Link>
        </p>
        <p className="auth-note">
          <Link to="/signin">{t("auth.forgotPassword.backToSignIn")}</Link>
        </p>
      </AuthLayout>
    );
  }

  if (phase.status === "done") {
    return (
      <AuthLayout>
        <AuthHead title={t("auth.resetPassword.title")} />
        <Banner
          variant="success"
          title={t("auth.resetPassword.done.title")}
          message={t("auth.resetPassword.done.body")}
        />
        <p className="auth-note">
          <Link to="/signin">{t("auth.acceptInvitation.goToSignIn")}</Link>
        </p>
      </AuthLayout>
    );
  }

  const disabled = phase.status === "submitting" || phase.status === "rate-limited";
  const invalid = phase.status === "error";

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const newPassword = (form.elements.namedItem("new_password") as HTMLInputElement).value;
    const confirmPassword = (form.elements.namedItem("confirm_password") as HTMLInputElement).value;

    const validationError = validateResetPasswordForm(newPassword, confirmPassword);
    if (validationError) {
      setPhase({ status: "error", messageKey: validationError });
      return;
    }

    setPhase({ status: "submitting" });
    const res = await confirmPasswordReset({ token, new_password: newPassword });
    setPhase(
      phaseFromResolution(
        resolvePasswordResetConfirm({
          status: res.status,
          error: res.error as { error?: { request_id?: string } } | undefined,
          retryAfterSeconds: res.retryAfterSeconds,
        }),
      ),
    );
  }

  return (
    <AuthLayout>
      <AuthHead title={t("auth.resetPassword.title")} subtitle={t("auth.resetPassword.subtitle")} />
      <ResetErrorBanners phase={phase} />
      <form className="auth-fields" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="new_password">{t("auth.account.new.label")}</label>
          <PasswordInput
            id="new_password"
            name="new_password"
            autoComplete="new-password"
            disabled={disabled}
            invalid={invalid}
            describedBy="new-password-hint"
            required
          />
          <p id="new-password-hint" className="field__hint">
            {t("auth.account.new.hint")}
          </p>
        </div>
        <div className="field">
          <label htmlFor="confirm_password">{t("auth.account.confirm.label")}</label>
          <PasswordInput
            id="confirm_password"
            name="confirm_password"
            autoComplete="new-password"
            disabled={disabled}
            invalid={invalid}
            required
          />
        </div>
        <ResetSubmitButton
          phase={phase}
          idleKey="auth.resetPassword.submit"
          submittingKey="auth.resetPassword.submitting"
        />
      </form>
      <p className="auth-note">
        <Link to="/forgot-password">{t("auth.resetPassword.requestNewLink")}</Link>
      </p>
      <p className="auth-note">
        <Link to="/signin">{t("auth.forgotPassword.backToSignIn")}</Link>
      </p>
    </AuthLayout>
  );
}
