import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import { queryKeys } from "@/lib/query";
import { useAcceptInvitation } from "@/operators/useMembers";
/**
 * SF5-4 — Accept invitation (public, T026/T028). Sibling of SF-1 sign-in: the
 * same RT-971 public frame (`AuthLayout`, canvas «تسجيل الدخول»), NOT behind
 * the protected gate. The accept token (from the email
 * link, `?token=`) authenticates the request (`acceptInvitation` is
 * `security: []`). New invitees set a display name + password; existing users
 * need neither.
 *
 * On 200 a session is established backend-side; we invalidate the active-context
 * query (so the shell does not render a stale session-lost state from cache),
 * then navigate to `/` where ProtectedArea resolves the new context. On 400 the
 * token is invalid/expired — rendered generically, with a path back to sign-in.
 *
 * RT-399: copy comes from the `auth.acceptInvitation.*` catalog; the error state
 * keeps a message key, never translated text.
 */
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AuthHead, AuthLayout } from "./AuthLayout";
import { PasswordInput } from "./PasswordInput";

export function AcceptInvitation(): React.JSX.Element {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accept = useAcceptInvitation();
  const t = useT();
  const [error, setError] = useState<MessageKey | undefined>();

  const invalidToken = token.length === 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    const form = event.currentTarget;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    const displayName = (form.elements.namedItem("display_name") as HTMLInputElement).value;

    const res = await accept.mutateAsync({
      token,
      password: password || undefined,
      display_name: displayName || undefined,
    });
    if (res.status >= 400) {
      setError("auth.acceptInvitation.errors.invalidLink");
      return;
    }
    // Session established: drop the cached context so the shell re-fetches it.
    await qc.invalidateQueries({ queryKey: queryKeys.activeContext });
    navigate("/", { replace: true });
  }

  if (invalidToken) {
    return (
      <AuthLayout>
        <AuthHead title={t("auth.acceptInvitation.titleInvalid")} />
        <Banner variant="danger" message={t("auth.acceptInvitation.errors.invalidLink")} />
        <p className="auth-note">
          <Link to="/signin">{t("auth.acceptInvitation.goToSignIn")}</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHead
        title={t("auth.acceptInvitation.title")}
        subtitle={t("auth.acceptInvitation.subtitle")}
      />

      {error ? <Banner variant="danger" message={t(error)} /> : null}

      <form className="auth-fields" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="display_name">{t("auth.acceptInvitation.displayName.label")}</label>
          <input
            className="input"
            id="display_name"
            name="display_name"
            autoComplete="name"
            disabled={accept.isPending}
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t("auth.acceptInvitation.password.label")}</label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            disabled={accept.isPending}
            describedBy="password-hint"
          />
          <p id="password-hint" className="field__hint">
            {t("auth.acceptInvitation.password.hint")}
          </p>
        </div>
        <GatedButton className="btn-primary auth-submit" type="submit" busy={accept.isPending}>
          {t(
            accept.isPending ? "auth.acceptInvitation.submitting" : "auth.acceptInvitation.submit",
          )}
        </GatedButton>
      </form>

      <p className="auth-note">
        {t.rich("auth.acceptInvitation.haveAccess", {
          signIn: <Link to="/signin">{t("auth.acceptInvitation.signInLink")}</Link>,
        })}
      </p>
    </AuthLayout>
  );
}
