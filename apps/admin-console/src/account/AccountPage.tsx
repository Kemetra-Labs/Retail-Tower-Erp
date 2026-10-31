import { PasswordInput } from "@/auth/PasswordInput";
import { Banner } from "@/components/Banner";
import {
  FormErrorSummary,
  type SummaryEntry,
  useSummaryFocus,
} from "@/components/FormErrorSummary";
import { FormField } from "@/components/FormField";
import { FormAside, FormPage, FormPanel, FormSection } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { type MessageKey, type T, useT } from "@/i18n";
import { createAuthRetry } from "@/lib/auth-interceptor";
import { changePassword, refreshSession } from "@/lib/client";
import { useSignOut } from "@/shell/useSignOut";
/**
 * RT-807 (owner decisions PW-1, PW-4; boards Password-change and
 * Password-states 3-9): the «حسابي» page, reached from the user menu. Its one
 * form changes the password through Backend-Core `changePassword` (RT-937),
 * which replaces it at the identity provider and signs the user out of their
 * other sessions; this one stays open.
 *
 * Fields: current, new and a confirm of the new one. The confirm is a client
 * match check only (PW-4); it is never sent. No strength meter, rule list or
 * length bound (PW-2): the provider sets the rules and answers a rejected one
 * with the generic 400.
 *
 * Passwords live only in the uncontrolled inputs: read at submit, never put in
 * state, a query cache, a URL or a log, and cleared after a change or a refusal.
 * The aside is a light panel (PC-5).
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type PasswordChangeFields,
  type PasswordChangeOutcome,
  passwordChangeBody,
  resolvePasswordChange,
} from "./passwordChangeLogic";

const FIELD_IDS = { current: "account-current", next: "account-new", confirm: "account-confirm" };
type FieldName = keyof typeof FIELD_IDS;
type FieldErrors = Partial<Record<FieldName, MessageKey>>;

/** Client checks before anything is sent: every field filled, the confirm matching. */
function validate(fields: PasswordChangeFields): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.current === "") errors.current = "auth.account.errors.currentRequired";
  if (fields.next === "") errors.next = "auth.account.errors.newRequired";
  if (fields.confirm === "") errors.confirm = "auth.account.errors.confirmRequired";
  else if (fields.next !== "" && fields.next !== fields.confirm) {
    errors.confirm = "auth.account.errors.mismatch";
  }
  return errors;
}

function readFields(form: HTMLFormElement): PasswordChangeFields {
  const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
  return {
    current: value("current_password"),
    next: value("new_password"),
    confirm: value("confirm_password"),
  };
}

function summaryEntries(t: T, errors: FieldErrors): SummaryEntry[] {
  return (Object.keys(FIELD_IDS) as FieldName[]).flatMap((name) => {
    const key = errors[name];
    return key ? [{ fieldId: FIELD_IDS[name], message: t(key) }] : [];
  });
}

/** Runs the change through a per-attempt 401 refresh-once; a lost session reads as 401. */
async function submitChange(fields: PasswordChangeFields): Promise<PasswordChangeOutcome> {
  const withAuthRetry = createAuthRetry({
    refreshSession: async () => {
      const r = await refreshSession();
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    },
    onSessionLost: () => {},
  });
  try {
    const result = await withAuthRetry(() => changePassword(passwordChangeBody(fields)));
    return resolvePasswordChange({
      status: result.status,
      error: result.error as { error?: { request_id?: string } } | undefined,
      retryAfter: result.retryAfter,
    });
  } catch {
    // No response at all: the provider may still have replaced it.
    return resolvePasswordChange({ status: 0 });
  }
}

function OutcomeBanner({
  outcome,
}: Readonly<{ outcome: PasswordChangeOutcome }>): React.JSX.Element | null {
  const t = useT();
  switch (outcome.kind) {
    case "changed":
      return (
        <Banner
          variant="success"
          title={t("auth.account.changed.title")}
          message={t("auth.account.changed.body")}
        />
      );
    case "refused":
      return (
        <Banner
          variant="danger"
          title={t("auth.account.errors.refused.title")}
          message={t("auth.account.errors.refused.body")}
          requestId={outcome.requestId}
        />
      );
    case "no-link":
      return (
        <Banner
          variant="warning"
          message={t("auth.account.errors.noLink")}
          requestId={outcome.requestId}
        />
      );
    case "rate-limited":
      return (
        <Banner
          variant="warning"
          message={t("auth.signIn.errors.rateLimited", { count: outcome.retryAfterSeconds })}
        />
      );
    case "not-confirmed":
      return (
        <Banner
          variant="warning"
          message={t("auth.account.errors.notConfirmed")}
          requestId={outcome.requestId}
        />
      );
    case "session-expired":
      return <Banner variant="danger" message={t("auth.account.errors.sessionExpired")} />;
    default:
      return (
        <Banner
          variant="danger"
          message={t("auth.account.errors.failed")}
          requestId={outcome.requestId}
        />
      );
  }
}

function WhatHappens(): React.JSX.Element {
  const t = useT();
  return (
    <FormAside title={t("auth.account.aside.title")}>
      <ol>
        <li>{t("auth.account.aside.provider")}</li>
        <li>{t("auth.account.aside.sessions")}</li>
      </ol>
    </FormAside>
  );
}

function PasswordField({
  name,
  inputName,
  label,
  autoComplete,
  hint,
  error,
  disabled,
}: Readonly<{
  name: FieldName;
  inputName: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  hint?: string;
  error?: string;
  disabled: boolean;
}>): React.JSX.Element {
  const id = FIELD_IDS[name];
  return (
    <FormField id={id} label={label} required hint={hint} error={error}>
      {(aria) => (
        <PasswordInput
          id={id}
          name={inputName}
          autoComplete={autoComplete}
          disabled={disabled}
          invalid={aria["aria-invalid"] === true}
          describedBy={aria["aria-describedby"]}
          required
        />
      )}
    </FormField>
  );
}

export function AccountPage(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const { context } = useActiveContextValue();
  const summary = useSummaryFocus();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [outcome, setOutcome] = useState<PasswordChangeOutcome | null>(null);
  const [pending, setPending] = useState(false);

  // After a refusal the cleared form starts over at the current password (board
  // state 5). An effect, because the inputs are still disabled until this render.
  useEffect(() => {
    if (outcome?.kind === "refused") document.getElementById(FIELD_IDS.current)?.focus();
  }, [outcome]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = readFields(form);
    const found = validate(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      summary.focusSummary();
      return;
    }
    setOutcome(null);
    setPending(true);
    const next = await submitChange(fields);
    setPending(false);
    setOutcome(next);
    if (next.kind === "changed" || next.kind === "refused") form.reset();
    if (next.kind === "session-expired") void signOut();
  }

  const email = context?.user?.email;
  const blocked = outcome?.kind === "no-link";
  const fieldError = (name: FieldName) => (errors[name] ? t(errors[name]) : undefined);

  return (
    <FormPage
      title={t("auth.account.title")}
      subtitle={
        email ? t.rich("auth.account.subtitle", { email: <bdi dir="ltr">{email}</bdi> }) : undefined
      }
      notices={outcome ? <OutcomeBanner outcome={outcome} /> : null}
      aside={<WhatHappens />}
    >
      <FormPanel
        onSubmit={onSubmit}
        onReset={() => setErrors({})}
        summary={<FormErrorSummary ref={summary.ref} entries={summaryEntries(t, errors)} />}
        actions={
          <>
            <GatedButton type="submit" className="btn-primary" busy={pending} disabled={blocked}>
              {t("auth.account.submit")}
            </GatedButton>
            <button type="reset" className="btn-ghost" disabled={pending}>
              {t("auth.account.cancel")}
            </button>
          </>
        }
      >
        <FormSection title={t("auth.account.password.title")}>
          <PasswordField
            name="current"
            inputName="current_password"
            label={t("auth.account.current.label")}
            autoComplete="current-password"
            error={fieldError("current")}
            disabled={pending}
          />
          <PasswordField
            name="next"
            inputName="new_password"
            label={t("auth.account.new.label")}
            autoComplete="new-password"
            hint={t("auth.account.new.hint")}
            error={fieldError("next")}
            disabled={pending}
          />
          <PasswordField
            name="confirm"
            inputName="confirm_password"
            label={t("auth.account.confirm.label")}
            autoComplete="new-password"
            error={fieldError("confirm")}
            disabled={pending}
          />
        </FormSection>
      </FormPanel>
    </FormPage>
  );
}
