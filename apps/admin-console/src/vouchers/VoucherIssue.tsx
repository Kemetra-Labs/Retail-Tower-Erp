import { Banner } from "@/components/Banner";
import { Drawer } from "@/components/Drawer";
import { FormField } from "@/components/FormField";
import { FormPanel, FormSection } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { InlineError } from "@/components/InlineError";
import { type MessageKey, useT } from "@/i18n";
import { CURRENCY } from "@/i18n/format";
import { type VoucherIssueBody, consoleIssueVouchers } from "@/lib/client";
import { textField } from "@/lib/form-field";
/**
 * RT-1109 issue drawer: form → one POST → the codes, once.
 *
 * Non-replayable issue (RT-82 K3): every submit mints a NEW Idempotency-Key and
 * nothing retries automatically. A same-key retry would be 409 within the 72 h
 * window and could never return the codes. When the answer is lost or unclear
 * (network failure, 5xx, 425, a key conflict), the batch may exist without its
 * codes: the drawer stops offering Issue and sends the operator to the list, to
 * cancel what they cannot hand out (the contract's recovery).
 *
 * After a 201 the drawer shows the codes (VoucherCodes) and cannot be dismissed
 * by Escape or the scrim: only the explicit "I saved the codes" closes it. The
 * batch is held in this component's state only, and dropped on close.
 *
 * The value is typed in the tenant currency's major units. The contract says the
 * currency is the tenant default and returns it per voucher; the Console has no
 * read of it before issuing, so the form assumes `CURRENCY` (EGP), the Admin
 * default (RT-399), and the codes view shows the currency the server returned.
 */
import { useState } from "react";
import { VoucherCodes } from "./VoucherCodes";
import {
  MAX_COUNT,
  type VoucherDraftErrors,
  type VoucherIssueDraft,
  buildIssueBody,
} from "./voucherIssueForm";
import { type VoucherIssueResponse, currencyDigits } from "./voucherLogic";
import { classifyIssueOutcome, newIdempotencyKey } from "./voucherOutcomes";

type Store = { id: string; name?: string };

type Phase =
  | { kind: "form" }
  | { kind: "codes"; batch: VoucherIssueResponse }
  | { kind: "uncertain"; requestId?: string };

type BannerState = { variant: "danger" | "warning"; messageKey: MessageKey; requestId?: string };

export interface VoucherIssueProps {
  activeTenant: { id: string; name: string };
  stores: readonly Store[];
  /** Closes the drawer; the list refreshes either way. */
  onClose: () => void;
}

function StoreChoices({
  stores,
  chosen,
  onToggle,
  error,
}: Readonly<{
  stores: readonly Store[];
  chosen: readonly string[];
  onToggle: (id: string) => void;
  error?: string;
}>): React.JSX.Element {
  const t = useT();
  return (
    <fieldset className="form-section" aria-invalid={error ? true : undefined}>
      <legend className="form-section__title">{t("vouchers.issue.stores")}</legend>
      {stores.length === 0 ? <p className="content__sub">{t("vouchers.issue.noStores")}</p> : null}
      <ul className="vouchers__choices">
        {stores.map((store) => (
          <li key={store.id}>
            <label className="vouchers__choice">
              <input
                type="checkbox"
                name="storeIds"
                value={store.id}
                checked={chosen.includes(store.id)}
                onChange={() => onToggle(store.id)}
              />
              <bdi>{store.name ?? store.id}</bdi>
            </label>
          </li>
        ))}
      </ul>
      <InlineError message={error} />
    </fieldset>
  );
}

function readDraft(
  form: FormData,
  scope: "all" | "stores",
  chosen: readonly string[],
): VoucherIssueDraft {
  return {
    count: textField(form, "count"),
    amount: textField(form, "amount"),
    expiresAt: textField(form, "expiresAt"),
    scope,
    storeIds: chosen,
    note: textField(form, "note"),
  };
}

type Step = { phase: Phase } | { banner: BannerState };

/** One issue attempt under a NEW key; never retried. Lost or unclear answers are uncertain. */
async function issueOnce(body: VoucherIssueBody): Promise<Step> {
  try {
    const res = await consoleIssueVouchers(body, newIdempotencyKey());
    const outcome = classifyIssueOutcome(res);
    switch (outcome.kind) {
      case "issued":
        // A 201 without a body lost the codes: treat it as the uncertain case.
        return res.data
          ? { phase: { kind: "codes", batch: res.data as VoucherIssueResponse } }
          : { phase: { kind: "uncertain" } };
      case "uncertain":
        return { phase: { kind: "uncertain", requestId: outcome.requestId } };
      case "session":
        return { banner: { variant: "warning", messageKey: outcome.messageKey } };
      default:
        return {
          banner: {
            variant: "danger",
            messageKey: outcome.messageKey,
            requestId: outcome.requestId,
          },
        };
    }
  } catch {
    // The request left and no answer came back: the batch may exist.
    return { phase: { kind: "uncertain" } };
  }
}

/** The standing "codes are shown once" note, then the last refusal, if any. */
function IssueNotices({ banner }: Readonly<{ banner?: BannerState }>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <Banner variant="info" message={t("vouchers.issue.onceNote")} />
      {banner ? (
        <Banner
          variant={banner.variant}
          message={t(banner.messageKey)}
          requestId={banner.requestId}
        />
      ) : null}
    </>
  );
}

export function VoucherIssue({
  activeTenant,
  stores,
  onClose,
}: Readonly<VoucherIssueProps>): React.JSX.Element {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [errors, setErrors] = useState<VoucherDraftErrors>({});
  const [banner, setBanner] = useState<BannerState | undefined>();
  const [pending, setPending] = useState(false);
  const [scope, setScope] = useState<"all" | "stores">("all");
  const [chosen, setChosen] = useState<string[]>([]);

  const fieldError = (field: keyof VoucherDraftErrors): string | undefined => {
    const e = errors[field];
    return e ? t(e.messageKey, e.params) : undefined;
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setBanner(undefined);
    const built = buildIssueBody(
      readDraft(new FormData(e.currentTarget), scope, chosen),
      currencyDigits(CURRENCY),
    );
    if (!built.ok) {
      setErrors(built.errors);
      return; // client guard: nothing is sent
    }
    setErrors({});
    setPending(true);
    const step = await issueOnce(built.body);
    setPending(false);
    if ("phase" in step) setPhase(step.phase);
    else setBanner(step.banner);
  }

  if (phase.kind === "codes") {
    return (
      <Drawer title={t("vouchers.codes.title")} onClose={onClose} dismissible={false}>
        <VoucherCodes batch={phase.batch} onDone={onClose} />
      </Drawer>
    );
  }

  if (phase.kind === "uncertain") {
    return (
      <Drawer title={t("vouchers.issue.title")} onClose={onClose}>
        <Banner
          variant="warning"
          message={t("vouchers.issue.uncertain")}
          requestId={phase.requestId}
        />
        <div className="vouchers__actions">
          <button type="button" className="btn-primary" onClick={onClose}>
            {t("vouchers.issue.uncertainAction")}
          </button>
        </div>
      </Drawer>
    );
  }

  const tenantLine = t.rich("vouchers.issue.scopeLine", {
    tenant: (
      <strong>
        <bdi>{activeTenant.name}</bdi>
      </strong>
    ),
  });
  const formActions = (
    <>
      <GatedButton type="submit" className="btn-primary" busy={pending}>
        {t("vouchers.issue.submit")}
      </GatedButton>
      <button type="button" className="btn-ghost" disabled={pending} onClick={onClose}>
        {t("common.cancel")}
      </button>
    </>
  );

  return (
    <Drawer
      title={t("vouchers.issue.title")}
      scope={tenantLine}
      onClose={onClose}
      dismissible={!pending}
    >
      <IssueNotices banner={banner} />
      <FormPanel variant="plain" onSubmit={onSubmit} actions={formActions}>
        <FormSection>
          <FormField
            id="voucher-count"
            label={t("vouchers.issue.count")}
            hint={t("vouchers.issue.countHint", { max: MAX_COUNT })}
            required
            error={fieldError("count")}
          >
            {(aria) => (
              <input
                id="voucher-count"
                name="count"
                className="input"
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                defaultValue="1"
                {...aria}
              />
            )}
          </FormField>

          <FormField
            id="voucher-amount"
            label={t("vouchers.issue.amount")}
            hint={t("vouchers.issue.amountHint")}
            required
            error={fieldError("amount")}
          >
            {(aria) => (
              <input
                id="voucher-amount"
                name="amount"
                className="input"
                inputMode="decimal"
                autoComplete="off"
                dir="ltr"
                {...aria}
              />
            )}
          </FormField>

          <FormField
            id="voucher-expires"
            label={t("vouchers.issue.expiresAt")}
            hint={t("vouchers.issue.expiresHint")}
            error={fieldError("expiresAt")}
          >
            {(aria) => (
              <input
                id="voucher-expires"
                name="expiresAt"
                type="datetime-local"
                className="input"
                {...aria}
              />
            )}
          </FormField>
        </FormSection>

        <fieldset className="form-section">
          <legend className="form-section__title">{t("vouchers.issue.scope")}</legend>
          <label className="vouchers__radio">
            <input
              type="radio"
              name="scope"
              value="all"
              checked={scope === "all"}
              onChange={() => setScope("all")}
            />
            {t("vouchers.issue.scopeAll")}
          </label>
          <label className="vouchers__radio">
            <input
              type="radio"
              name="scope"
              value="stores"
              checked={scope === "stores"}
              onChange={() => setScope("stores")}
            />
            {t("vouchers.issue.scopeStores")}
          </label>
        </fieldset>

        {scope === "stores" ? (
          <StoreChoices
            stores={stores}
            chosen={chosen}
            error={fieldError("storeIds")}
            onToggle={(id) =>
              setChosen((prev) =>
                prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
              )
            }
          />
        ) : null}

        <FormSection>
          <FormField
            id="voucher-note"
            label={t("vouchers.issue.note")}
            hint={t("vouchers.issue.noteHint")}
            error={fieldError("note")}
          >
            {(aria) => (
              <input id="voucher-note" name="note" className="input" autoComplete="off" {...aria} />
            )}
          </FormField>
        </FormSection>
      </FormPanel>
    </Drawer>
  );
}
