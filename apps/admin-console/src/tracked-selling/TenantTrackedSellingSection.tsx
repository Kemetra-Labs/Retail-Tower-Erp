/**
 * RT-455 part 1 tenant page section: the tenant's tracked-selling switch
 * (`getTrackedSellingSetting` / `setTrackedSellingSetting`, `inventory.yaml`
 * 1.12.0-draft; RT-451 owner decisions OD-T1..OD-T7, comments 16215, 16217).
 *
 * - Owner / tenant_admin: on/off, the last change (when and by whom), and the
 *   preconditions that do not hold now, in plain words. Switching on is sent
 *   as is; a 409 `tracked_selling_preconditions_unmet` is explained and the
 *   read is fetched again so the list names what is missing. Switching off
 *   has an inline confirm step that names its consequence (UX-05.2).
 * - store_manager: on/off only (OD-T6), no action.
 * - Anyone else, another tenant than the session's, or the gate's 404: nothing
 *   is rendered.
 * - On with `preconditionsMet: false`: a warning (OD-T7); the switch stays on.
 *
 * The server decides every state; this section renders it and sends the
 * command. Nothing here evaluates a precondition.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { formatDateTime, useT } from "@/i18n";
import type { TrackedSellingSetting } from "@/lib/tracked-selling-queries";
import { PeopleNames, PersonRef } from "@/people/PersonRef";
import { useEffect, useRef, useState } from "react";
import {
  type SwitchOutcome,
  type TrackedSellingRead,
  type TrackedSellingView,
  preconditionKey,
  showPreconditionWarning,
  trackedSellingViewFor,
} from "./trackedSellingLogic";
import { useTrackedSellingQuery, useTrackedSellingSwitch } from "./useTrackedSelling";
import "@/components/confirm-delete.css";
import "./tracked-selling.css";

const TITLE_ID = "tracked-selling-title";

// --- Read states ---------------------------------------------------------------------

function ReadFailed({
  read,
  onRetry,
}: Readonly<{ read: Extract<TrackedSellingRead, { kind: "error" }>; onRetry: () => void }>) {
  const t = useT();
  return (
    <Banner
      variant="danger"
      message={t(
        read.status === 401 ? "trackedSelling.sessionExpired" : "trackedSelling.loadFailed",
      )}
      requestId={read.requestId}
      action={
        <button type="button" className="btn-secondary" onClick={onRetry}>
          {t("trackedSelling.retry")}
        </button>
      }
    />
  );
}

function StateBadge({ enabled }: Readonly<{ enabled: boolean }>): React.JSX.Element {
  const t = useT();
  return (
    <span
      className={enabled ? "badge badge--success" : "badge badge--pending"}
      data-testid="tracked-selling-state"
    >
      {t(enabled ? "trackedSelling.state.on" : "trackedSelling.state.off")}
    </span>
  );
}

// --- Owner / tenant_admin view --------------------------------------------------------

function LastChange({ setting }: Readonly<{ setting: TrackedSellingSetting }>) {
  const t = useT();
  if (!setting.changedAt) return <>{t("trackedSelling.changed.never")}</>;
  return (
    <>
      {t("trackedSelling.changed.at", { at: formatDateTime(setting.changedAt) })}{" "}
      {setting.changedBy ? <PersonRef userId={setting.changedBy} /> : "—"}
    </>
  );
}

function Preconditions({ setting }: Readonly<{ setting: TrackedSellingSetting }>) {
  const t = useT();
  const unmet = setting.unmetPreconditions ?? [];
  return (
    <div className="tracked-selling__preconditions" data-testid="tracked-selling-preconditions">
      <h3 className="tracked-selling__subtitle">{t("trackedSelling.preconditions.title")}</h3>
      {unmet.length === 0 ? (
        <p className="tracked-selling__met">{t("trackedSelling.preconditions.allMet")}</p>
      ) : (
        <>
          <p className="tracked-selling__lead">{t("trackedSelling.preconditions.unmet")}</p>
          <ul className="tracked-selling__list">
            {unmet.map((code) => {
              const key = preconditionKey(code);
              return (
                <li key={code}>
                  {key ? (
                    t(key)
                  ) : (
                    <>
                      {t("trackedSelling.precondition.unknown")} <bdi dir="ltr">{code}</bdi>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="field__hint">{t("trackedSelling.preconditions.failClosed")}</p>
        </>
      )}
    </div>
  );
}

function OutcomeNotice({ outcome }: Readonly<{ outcome: SwitchOutcome | undefined }>) {
  const t = useT();
  if (!outcome) return null;
  switch (outcome.kind) {
    case "saved":
      return (
        <Banner
          variant="success"
          message={t(
            outcome.setting.enabled ? "trackedSelling.saved.on" : "trackedSelling.saved.off",
          )}
        />
      );
    case "unmet":
      return (
        <Banner
          variant="warning"
          message={t("trackedSelling.unmet")}
          requestId={outcome.requestId}
        />
      );
    case "unavailable":
      return <Banner variant="warning" message={t("trackedSelling.unavailable")} />;
    case "forbidden":
      return (
        <Banner
          variant="danger"
          message={t("trackedSelling.forbidden")}
          requestId={outcome.requestId}
        />
      );
    case "rateLimited":
      return (
        <Banner
          variant="warning"
          message={
            outcome.retryAfter
              ? t("trackedSelling.rateLimitedFor", { count: outcome.retryAfter })
              : t("trackedSelling.rateLimited")
          }
        />
      );
    case "rejected":
      return (
        <Banner
          variant="danger"
          message={[
            t("trackedSelling.rejected", { status: outcome.status }),
            outcome.code ? t("trackedSelling.code", { code: outcome.code }) : "",
          ]
            .filter(Boolean)
            .join(" ")}
          requestId={outcome.requestId}
        />
      );
    case "failed":
      return <Banner variant="danger" message={t("trackedSelling.failed")} />;
  }
}

function ConfirmOff({
  pending,
  onConfirm,
  onCancel,
}: Readonly<{ pending: boolean; onConfirm: () => void; onCancel: () => void }>) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Safe default focus: the step opens on «إلغاء», not on the consequence.
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <section
      className="confirm-delete tracked-selling__confirm"
      aria-label={t("trackedSelling.confirm.label")}
      data-testid="tracked-selling-confirm"
    >
      <p className="confirm-delete__msg">{t("trackedSelling.confirm.body")}</p>
      <div className="confirm-delete__actions">
        <GatedButton type="button" className="btn-destructive" onClick={onConfirm} busy={pending}>
          {t("trackedSelling.confirm.yes")}
        </GatedButton>
        <button
          ref={cancelRef}
          type="button"
          className="btn-ghost"
          onClick={onCancel}
          disabled={pending}
        >
          {t("trackedSelling.confirm.cancel")}
        </button>
      </div>
    </section>
  );
}

function ManageView({
  tenantId,
  setting,
}: Readonly<{ tenantId: string; setting: TrackedSellingSetting }>): React.JSX.Element {
  const t = useT();
  const toggle = useTrackedSellingSwitch(tenantId);
  const [outcome, setOutcome] = useState<SwitchOutcome | undefined>();
  const [confirming, setConfirming] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  /** Focus the action that replaced the one used (UX-11.8: the next meaningful owner). */
  function focusAction(): void {
    requestAnimationFrame(() => actionsRef.current?.querySelector("button")?.focus());
  }

  async function send(enabled: boolean): Promise<void> {
    setOutcome(undefined);
    const result = await toggle.submit({ enabled });
    setConfirming(false);
    setOutcome(result);
    focusAction();
  }

  function cancelConfirm(): void {
    setConfirming(false);
    focusAction();
  }

  return (
    <PeopleNames ids={[setting.changedBy]}>
      {showPreconditionWarning(setting) ? (
        <Banner
          variant="warning"
          title={t("trackedSelling.warning.title")}
          message={t("trackedSelling.warning.body")}
        />
      ) : null}

      <dl className="surface__detail">
        <div className="field-row">
          <dt className="field-row__label">{t("trackedSelling.field.state")}</dt>
          <dd className="field-row__value">
            <StateBadge enabled={setting.enabled} />
          </dd>
        </div>
        <div className="field-row">
          <dt className="field-row__label">{t("trackedSelling.field.changed")}</dt>
          <dd className="field-row__value" data-testid="tracked-selling-changed">
            <LastChange setting={setting} />
          </dd>
        </div>
      </dl>

      <Preconditions setting={setting} />

      <OutcomeNotice outcome={outcome} />

      {confirming ? (
        <ConfirmOff
          pending={toggle.pending}
          onConfirm={() => void send(false)}
          onCancel={cancelConfirm}
        />
      ) : (
        <div className="surface__actions" ref={actionsRef}>
          {setting.enabled ? (
            <button
              type="button"
              className="btn-danger-quiet"
              onClick={() => {
                setOutcome(undefined);
                setConfirming(true);
              }}
            >
              {t("trackedSelling.turnOff")}
            </button>
          ) : (
            <GatedButton
              type="button"
              className="btn-primary"
              busy={toggle.pending}
              onClick={() => void send(true)}
            >
              {t("trackedSelling.turnOn")}
            </GatedButton>
          )}
        </div>
      )}
    </PeopleNames>
  );
}

// --- Section ---------------------------------------------------------------------------

function SectionBody({
  tenantId,
  role,
  view,
}: Readonly<{ tenantId: string; role: string; view: TrackedSellingView }>) {
  const t = useT();
  const query = useTrackedSellingQuery(tenantId, role);
  const read = query.data;
  // The deployment gate is off: the setting does not exist for this tenant.
  if (read?.kind === "unavailable") return null;

  return (
    <section
      className="tracked-selling"
      aria-labelledby={TITLE_ID}
      data-testid="tracked-selling-section"
    >
      <header>
        <h2 id={TITLE_ID} className="surface__section-title">
          {t("trackedSelling.title")}
        </h2>
        <p className="content__sub">
          {t(view === "manage" ? "trackedSelling.sub.manage" : "trackedSelling.sub.status")}
        </p>
      </header>

      {!read ? <ListState state="loading" label={t("trackedSelling.loadingNoun")} /> : null}
      {read?.kind === "error" ? (
        <ReadFailed read={read} onRetry={() => void query.refetch()} />
      ) : null}
      {read?.kind === "ok" && view === "manage" ? (
        <ManageView tenantId={tenantId} setting={read.setting} />
      ) : null}
      {read?.kind === "ok" && view === "status" ? (
        <dl className="surface__detail">
          <div className="field-row">
            <dt className="field-row__label">{t("trackedSelling.field.state")}</dt>
            <dd className="field-row__value">
              <StateBadge enabled={read.setting.enabled} />
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

export function TenantTrackedSellingSection({
  tenantId,
}: Readonly<{ tenantId: string }>): React.JSX.Element | null {
  const { context } = useActiveContextValue();
  const role = context?.active_role_code;
  const view = trackedSellingViewFor(role);
  // Only for the tenant the session is in: the API reads the session's tenant.
  if (!view || !role || context?.active_tenant?.id !== tenantId) return null;
  return <SectionBody tenantId={tenantId} role={role} view={view} />;
}
