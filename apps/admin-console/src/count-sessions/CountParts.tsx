/**
 * RT-1425 shared pieces of the Count Session screens: the outcome banner (a typed
 * refusal reads by its machine code, never by the server's words), the state
 * badge and the operator and product labels. Machine data is LTR-isolated.
 */
import { NoAccess } from "@/auth/NoAccess";
import { Banner } from "@/components/Banner";
import { type MessageKey, useT } from "@/i18n";
import { canReadInventory } from "@/inventory/inventoryLogic";
import { Machine, ReadError } from "@/inventory/parts";
import { type InventoryScope, useInventoryScope } from "@/inventory/useInventory";
import { usePeopleNames } from "@/people/usePeopleNames";
import { ScopeMismatchBanner } from "@/shell/ScopeMismatchBanner";
import { useSignOut } from "@/shell/useSignOut";
import {
  type CountOutcome,
  countStateKey,
  countStateTone,
  deviceReasonKey,
  warehouseReasonKey,
} from "./countLogic";

/** A rejected or unanswered write, in place: What -> Safety -> Action -> Evidence. */
export function OutcomeBanner({
  outcome,
  title,
}: Readonly<{ outcome: CountOutcome | null; title: string }>): React.JSX.Element | null {
  const t = useT();
  if (!outcome || outcome.kind === "ok") return null;
  if (outcome.kind === "failed") {
    return <Banner variant="danger" title={title} message={t("counts.error.noAnswer")} />;
  }
  const message =
    outcome.status === 429 && outcome.retryAfter
      ? t("counts.error.rateLimitedFor", { count: outcome.retryAfter })
      : t(outcome.messageKey);
  return (
    <div data-testid="count-outcome">
      <Banner
        variant={outcome.status === 409 ? "warning" : "danger"}
        title={title}
        message={message}
        requestId={outcome.requestId}
      />
      {outcome.code ? (
        <p className="counts__note">
          {t.rich("counts.error.code", { code: <Machine value={outcome.code} /> })}
        </p>
      ) : null}
      {outcome.blockers ? <Blockers details={outcome.blockers} /> : null}
    </div>
  );
}

/** What blocks the Count Cut, as the server named it: devices and mapped warehouses. */
function Blockers({
  details,
}: Readonly<{ details: NonNullable<Extract<CountOutcome, { kind: "rejected" }>["blockers"]> }>) {
  const t = useT();
  return (
    <div className="counts__blockers" data-testid="count-blockers">
      {details.devices.length > 0 ? (
        <>
          <h3 className="counts__subtitle">{t("counts.cut.devices")}</h3>
          <ul className="counts__list">
            {details.devices.map((d) => (
              <li key={d.deviceId}>
                <Machine value={d.deviceId} /> · {t(deviceReasonKey(d.reason))}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {details.warehouses.length > 0 ? (
        <>
          <h3 className="counts__subtitle">{t("counts.cut.warehouses")}</h3>
          <ul className="counts__list">
            {details.warehouses.map((w) => (
              <li key={w.warehouseRef}>
                <Machine value={w.warehouseRef} /> · {t(warehouseReasonKey(w.reason))}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function StateBadge({ state }: Readonly<{ state: string }>): React.JSX.Element {
  const t = useT();
  return <span className={`badge ${countStateTone(state)}`.trim()}>{t(countStateKey(state))}</span>;
}

/** Operator display names for the ids given; an unresolved id shows as machine data. */
export function usePersonLabel(ids: readonly (string | null | undefined)[]) {
  const names = usePeopleNames(ids);
  return (id: string): React.JSX.Element => {
    const name = names.get(id.toLowerCase());
    return name ? <bdi dir="auto">{name}</bdi> : <Machine value={id} />;
  };
}

/** A catalog product name when it resolved, else the id as machine data. */
export function ProductLabel({
  id,
  names,
}: Readonly<{ id: string; names: ReadonlyMap<string, string> }>): React.JSX.Element {
  const name = names.get(id);
  return name ? <bdi dir="auto">{name}</bdi> : <Machine value={id} />;
}

/**
 * The gate every count route shares: the inventory read roles, a chosen tenant, and
 * route ids that are UUIDs (a malformed id would be a contract 400, so it is never
 * sent and reads as not available).
 */
export function CountGate({
  valid,
  storeId,
  notFoundKey,
  children,
}: Readonly<{
  valid: boolean;
  storeId: string | undefined;
  notFoundKey: MessageKey;
  children: (scope: InventoryScope) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const scope = useInventoryScope();
  const signOut = useSignOut();
  let body: React.ReactNode;
  if (!canReadInventory(scope.role)) body = <NoAccess onSignOut={signOut} />;
  else if (!scope.tenantId) {
    body = (
      <div className="surface">
        <p className="content__sub">{t("counts.scopePrompt")}</p>
      </div>
    );
  } else if (valid) body = children(scope);
  else {
    body = (
      <div className="surface">
        <ScopeMismatchBanner storeId={storeId} />
        <ReadError
          error={{ kind: "not-found" }}
          failedKey="counts.list.loadFailed"
          notFoundKey={notFoundKey}
          onRetry={() => undefined}
        />
      </div>
    );
  }
  return <>{body}</>;
}
