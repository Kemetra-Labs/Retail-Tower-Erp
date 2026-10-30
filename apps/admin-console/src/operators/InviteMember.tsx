import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { FormField } from "@/components/FormField";
import { FormPanel, FormSection } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import { type InvitationCreateBody, createInvitation, refreshSession } from "@/lib/client";
import { textField } from "@/lib/form-field";
import { useSignOut } from "@/shell/useSignOut";
/**
 * SF5-2 — Invite member drawer (T020/T021). Uncontrolled native form (email /
 * role / store-access). One `.btn-primary` "Send invitation". Calls
 * `createInvitation` through the idempotency + 401-disambiguation machinery:
 *
 *   - key generated once per submit; a retry (425) replays the SAME key
 *   - 201 / replay      → close, refresh the list
 *   - 400 validation    → inline on the field
 *   - 400 key issue      → regenerate key + resubmit (not user-facing)
 *   - 403               → permission banner
 *   - 409 pending        → "already pending" warning banner
 *   - 409 key-conflict   → regenerate key + "please retry" banner (terminal for this key)
 *   - 425               → disabled submit + countdown, auto-retry with same key (≤ a bound)
 *   - precondition-401   → route to the scope chooser (handled by useInviteAuth)
 *   - session-expiry-401 → sign out (handled by useInviteAuth)
 */
import { useState } from "react";
import { StoreAccessField } from "./StoreAccessField";
import { classifyInviteOutcome, newIdempotencyKey } from "./inviteIdempotency";
import { runInviteWithAuth } from "./useInviteAuth";

export interface InviteMemberProps {
  activeTenant: { id: string; name: string };
  onClose: () => void;
  onInvited: () => void;
}

/** Banner copy is kept as a message key and translated at render (RT-399). */
type BannerState = { variant: "danger" | "warning"; messageKey: MessageKey; requestId?: string };

const MAX_TOO_EARLY_RETRIES = 3;

export function InviteMember({
  activeTenant,
  onClose,
  onInvited,
}: Readonly<InviteMemberProps>): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const [emailError, setEmailError] = useState<MessageKey | undefined>();
  const [banner, setBanner] = useState<BannerState | undefined>();
  const [pending, setPending] = useState(false);
  const [tooEarly, setTooEarly] = useState<number | null>(null);
  const [specific, setSpecific] = useState(false);

  async function submitWithKey(
    body: InvitationCreateBody,
    key: string,
    tooEarlyRetries: number,
  ): Promise<void> {
    const outcome = await runInviteWithAuth(
      () => createInvitation(body, key),
      async () => {
        const r = await refreshSession();
        return { ok: r.status >= 200 && r.status < 300, status: r.status };
      },
    );

    if (outcome.kind === "session-expired") {
      void signOut();
      return;
    }
    if (outcome.kind === "precondition") {
      // No active tenant: route to the RF-1 scope chooser (clear the store-less
      // scope so ProtectedArea renders the gate). Never a sign-out.
      setBanner({ variant: "warning", messageKey: "operators.invite.errors.selectTenant" });
      return;
    }

    const result = outcome.result;
    const classified = classifyInviteOutcome({
      status: result.status,
      headers: result.headers,
      error: result.error as { error?: { code?: string; request_id?: string } } | undefined,
    });

    switch (classified.kind) {
      case "created":
      case "replayed":
        onInvited();
        return;
      case "validation":
        setEmailError("operators.invite.errors.validation");
        return;
      case "regenerate-key":
        // Client-internal key fault: regenerate and resubmit once, silently.
        await submitWithKey(body, newIdempotencyKey(), tooEarlyRetries);
        return;
      case "forbidden":
        setBanner({
          variant: "danger",
          messageKey: "operators.invite.errors.forbidden",
          requestId: classified.requestId,
        });
        return;
      case "pending-exists":
        setBanner({
          variant: "warning",
          messageKey: "operators.invite.errors.pendingExists",
          requestId: classified.requestId,
        });
        return;
      case "key-conflict":
        setBanner({
          variant: "danger",
          messageKey: "operators.invite.errors.keyConflict",
          requestId: classified.requestId,
        });
        return;
      case "too-early": {
        if (tooEarlyRetries >= MAX_TOO_EARLY_RETRIES) {
          setBanner({
            variant: "danger",
            messageKey: "operators.invite.errors.tooLong",
          });
          return;
        }
        // Retry with the SAME key after Retry-After (bounded; visible countdown).
        setTooEarly(classified.retryAfterSeconds);
        await new Promise((r) => setTimeout(r, classified.retryAfterSeconds * 1000));
        setTooEarly(null);
        await submitWithKey(body, key, tooEarlyRetries + 1);
        return;
      }
      default:
        setBanner({
          variant: "danger",
          messageKey: "operators.invite.errors.generic",
          requestId: classified.requestId,
        });
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setEmailError(undefined);
    setBanner(undefined);
    const form = new FormData(e.currentTarget);
    const body: InvitationCreateBody = {
      email: textField(form, "email"),
      role_code: textField(form, "role_code"),
      store_access_kind: specific ? "specific" : "all",
      store_ids: specific
        ? textField(form, "store_ids")
            .split(/[\s,]+/)
            .filter(Boolean)
        : undefined,
    };
    setPending(true);
    try {
      await submitWithKey(body, newIdempotencyKey(), 0);
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer title={t("operators.invite.title")} onClose={onClose}>
      {banner ? (
        <Banner
          variant={banner.variant}
          message={t(banner.messageKey)}
          requestId={banner.requestId}
        />
      ) : null}

      <FormPanel
        variant="plain"
        onSubmit={onSubmit}
        actions={
          <>
            <GatedButton
              type="submit"
              className="btn-primary"
              busy={pending}
              disabled={tooEarly !== null}
            >
              {tooEarly !== null
                ? t("operators.invite.retrying", { count: tooEarly })
                : t("operators.invite.submit")}
            </GatedButton>
            <button type="button" className="btn-ghost" onClick={onClose} disabled={pending}>
              {t("common.cancel")}
            </button>
          </>
        }
      >
        <FormSection
          lead={t.rich("operators.invite.scopeLine", {
            tenant: (
              <strong>
                <bdi>{activeTenant.name}</bdi>
              </strong>
            ),
          })}
        >
          <FormField
            id="invite-email"
            label={t("operators.form.email")}
            required
            error={emailError ? t(emailError) : undefined}
            announceError
          >
            {(aria) => (
              <input
                id="invite-email"
                name="email"
                type="email"
                className="input"
                dir="ltr"
                autoComplete="off"
                {...aria}
              />
            )}
          </FormField>

          <FormField id="invite-role" label={t("operators.form.role")} required>
            {(aria) => (
              <input
                id="invite-role"
                name="role_code"
                className="input"
                autoComplete="off"
                {...aria}
              />
            )}
          </FormField>

          <StoreAccessField specific={specific} onSpecificChange={setSpecific} />
        </FormSection>
      </FormPanel>
    </Drawer>
  );
}
