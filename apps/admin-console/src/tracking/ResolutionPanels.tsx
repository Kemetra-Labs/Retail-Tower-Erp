/**
 * RT-455 part 2 (RT-451 S5 runtime, OD-1 and OD-9): the Tracking Resolution
 * queue. It lists the sales captured `tracking_unresolved`, newest capture
 * first, and binds an existing identity to every unresolved line through the
 * governed command (`bindTrackingResolution`).
 *
 * - owner and tenant_admin read the sales; only the owner may bind (high
 *   sensitivity, as the release): a tenant_admin sees the action recessed with
 *   the reason. A store_manager never sees a row: it gets the count for its own
 *   stores (OD-9), «—» while unknown, never zero.
 * - The bind captures a reason from the fixed list and a note that is always
 *   required, one identity per unresolved line, and asks to confirm: a
 *   resolution is final. The outcome is the server's: success only on a 200 with
 *   a body, a refusal shows its message and code as sent, no answer says the
 *   result is unknown and a retry with the same key is safe.
 * - Every rule (which identity is legal: product, hold, expiry) stays in
 *   Backend-Core; the Console lists the identities of the line's product and
 *   sends the choice.
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { Drawer } from "@/components/Drawer";
import { InlineError } from "@/components/InlineError";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import type {
  ResolutionQueueItem,
  ResolutionStatusFilter,
  UnresolvedLine,
} from "@/lib/tracking-queries";
import { useState } from "react";
import { LoadMore, Machine, Quantity, ReadError } from "../inventory/parts";
import type { InventoryScope, ReadState } from "../inventory/useInventory";
import { PagedPanel } from "./PagedPanel";
import { DrawerActions, ReasonFields, WriteResult } from "./TrackingForms";
import { ActorName, DateValue, ProductName, ReasonLabel, StoreName, When } from "./parts";
import { canBindResolution, lineReasonKey } from "./trackingLogic";
import { useProductIdentities, useResolutionQueue, useUnresolvedCount } from "./useTracking";
import { useBindResolution } from "./useTrackingWrites";
import { type BindDraft, type WriteErrors, buildBindCommand, validateBind } from "./writeLogic";

function Body({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="inventory__panel-body inventory__panel-body--solo">{children}</div>;
}

const STATUSES: readonly ResolutionStatusFilter[] = ["unresolved", "resolved", "all"];

const STATUS_KEYS = {
  unresolved: "tracking.resolution.status.unresolved",
  resolved: "tracking.resolution.status.resolved",
  all: "tracking.resolution.status.all",
} as const;

// --- The store_manager's count (OD-9) --------------------------------------------------

/** One line: how many sales wait for an identity in the manager's stores. */
export function QueueCountLine({
  count,
}: Readonly<{ count: ReadState<number> }>): React.JSX.Element {
  const t = useT();
  if (count.error) {
    return (
      <p className="inventory__note" data-testid="tracking-queue-count">
        {t("tracking.manager.queueCountFailed")}{" "}
        <button type="button" className="btn-ghost" onClick={count.retry}>
          {t("inventory.retry")}
        </button>
      </p>
    );
  }
  return (
    <p className="inventory__note" data-testid="tracking-queue-count">
      {t("tracking.manager.queueCount")}{" "}
      <strong>
        <bdi>{count.data === undefined ? "—" : count.data}</bdi>
      </strong>
    </p>
  );
}

export function ManagerQueueCount({ scope }: Readonly<{ scope: InventoryScope }>) {
  return <QueueCountLine count={useUnresolvedCount(scope)} />;
}

// --- Queue --------------------------------------------------------------------------

function LineSummary({ line }: Readonly<{ line: UnresolvedLine }>): React.JSX.Element {
  const t = useT();
  return (
    <li className="tracking__line">
      <ProductName id={line.tenantProductRef} />{" "}
      <span className="tracking__muted">
        <Quantity value={line.quantity} /> <bdi>{line.unit}</bdi>
      </span>
      <br />
      <span className="badge">{t(lineReasonKey(line.reason))}</span>
      {line.scannedCode ? (
        <>
          {" "}
          <Machine value={line.scannedCode} />
        </>
      ) : null}
    </li>
  );
}

function ResolvedBy({ item }: Readonly<{ item: ResolutionQueueItem }>): React.JSX.Element | null {
  const t = useT();
  const resolution = item.resolution;
  if (!resolution) return null;
  return (
    <div className="tracking__muted" data-testid="tracking-resolved-by">
      <ReasonLabel code={resolution.reasonCode} /> · <ActorName userId={resolution.resolvedBy} /> ·{" "}
      <When iso={resolution.resolvedAt} />
      <br />
      <bdi>{resolution.note}</bdi>
      <span className="visually-hidden">{t("tracking.resolution.col.resolution")}</span>
    </div>
  );
}

function QueueRow({
  item,
  role,
  onBind,
}: Readonly<{
  item: ResolutionQueueItem;
  role: string | null | undefined;
  onBind: (item: ResolutionQueueItem) => void;
}>): React.JSX.Element {
  const t = useT();
  const unresolved = item.status === "unresolved";
  const canBind = canBindResolution(role);
  return (
    <tr className="data-table__row data-table__row--static">
      <th scope="row">
        <Machine value={item.saleId} />
      </th>
      <td>
        <StoreName id={item.storeId} />
      </td>
      <td>
        <DateValue value={item.businessDate} />
      </td>
      <td>
        <When iso={item.capturedAt} />
      </td>
      <td>
        <ul className="tracking__lines">
          {item.unresolvedLines.map((line) => (
            <LineSummary key={line.saleLineId} line={line} />
          ))}
        </ul>
        <ResolvedBy item={item} />
      </td>
      <td>
        <span className={unresolved ? "badge badge--danger" : "badge"}>
          {t(STATUS_KEYS[item.status])}
        </span>
      </td>
      <td>
        {unresolved ? (
          canBind ? (
            <button type="button" className="btn-secondary" onClick={() => onBind(item)}>
              {t("tracking.resolution.bind")}
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              aria-disabled="true"
              aria-describedby="bind-why"
            >
              {t("tracking.resolution.bind")}
            </button>
          )
        ) : null}
      </td>
    </tr>
  );
}

function QueueTable({
  rows,
  role,
  onBind,
}: Readonly<{
  rows: readonly ResolutionQueueItem[];
  role: string | null | undefined;
  onBind: (item: ResolutionQueueItem) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips" data-testid="tracking-queue-table">
          <caption id={captionId} className="data-table__caption">
            {t("tracking.resolution.caption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("tracking.resolution.col.sale")}</th>
              <th scope="col">{t("tracking.col.store")}</th>
              <th scope="col">{t("tracking.resolution.col.businessDate")}</th>
              <th scope="col">{t("tracking.resolution.col.capturedAt")}</th>
              <th scope="col">{t("tracking.resolution.col.lines")}</th>
              <th scope="col">{t("tracking.col.status")}</th>
              <th scope="col">{t("tracking.col.action")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <QueueRow key={item.saleId} item={item} role={role} onBind={onBind} />
            ))}
          </tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}

export function ResolutionPanel({ scope }: Readonly<{ scope: InventoryScope }>): React.JSX.Element {
  const t = useT();
  const [status, setStatus] = useState<ResolutionStatusFilter>("unresolved");
  const [binding, setBinding] = useState<ResolutionQueueItem | null>(null);
  const list = useResolutionQueue(scope, status);
  const owner = canBindResolution(scope.role);

  const body = (
    <PagedPanel
      list={list}
      loadingKey="tracking.resolution.loadingNoun"
      failedKey="tracking.resolution.loadFailed"
      emptyKey="tracking.resolution.empty"
      moreKey="tracking.resolution.loadMore"
    >
      {(rows) => <QueueTable rows={rows} role={scope.role} onBind={setBinding} />}
    </PagedPanel>
  );
  return (
    <>
      <Body>
        <p className="tracking__muted">{t("tracking.resolution.intro")}</p>
        <div className="field tracking__filter">
          <label htmlFor="resolution-status">{t("tracking.resolution.statusLabel")}</label>
          <select
            id="resolution-status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as ResolutionStatusFilter)}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(STATUS_KEYS[value])}
              </option>
            ))}
          </select>
        </div>
        {owner ? null : (
          <p id="bind-why" className="tracking__muted" data-testid="tracking-bind-notice">
            {t("tracking.resolution.ownerOnly")}
          </p>
        )}
      </Body>
      {body}
      {binding && owner ? (
        <BindDrawer scope={scope} item={binding} onClose={() => setBinding(null)} />
      ) : null}
    </>
  );
}

// --- Bind drawer ----------------------------------------------------------------------

/** One unresolved line and the identity chosen for it, from the line's own product. */
function LineBinding({
  scope,
  line,
  value,
  error,
  onChange,
}: Readonly<{
  scope: InventoryScope;
  line: UnresolvedLine;
  value: string;
  error: boolean;
  onChange: (identityId: string) => void;
}>): React.JSX.Element {
  const t = useT();
  const identities = useProductIdentities(scope, line.tenantProductRef);
  const id = `bind-line-${line.saleLineId}`;
  return (
    <div className="field" data-testid="tracking-bind-line">
      <label htmlFor={id}>
        <ProductName id={line.tenantProductRef} /> · <Quantity value={line.quantity} />{" "}
        <bdi>{line.unit}</bdi>
      </label>
      <p className="tracking__muted">
        {t(lineReasonKey(line.reason))}
        {line.scannedCode ? (
          <>
            {" · "}
            <Machine value={line.scannedCode} />
          </>
        ) : null}
      </p>
      {identities.isLoading ? (
        <ListState state="loading" label={t("tracking.resolution.identitiesLoading")} />
      ) : null}
      {identities.error ? (
        <ReadError
          error={identities.error}
          failedKey="tracking.resolution.identitiesFailed"
          notFoundKey="tracking.resolution.identitiesFailed"
          onRetry={identities.retry}
        />
      ) : null}
      {identities.isLoading || identities.error ? null : (
        <>
          <select
            id={id}
            className="input"
            value={value}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{t("tracking.resolution.identityChoose")}</option>
            {identities.rows.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.code}
                {identity.expiryDate ? ` · ${identity.expiryDate}` : ""}
              </option>
            ))}
          </select>
          {identities.rows.length === 0 ? (
            <p className="tracking__muted">{t("tracking.resolution.identitiesNone")}</p>
          ) : null}
          <LoadMore
            hasMore={identities.hasMore}
            isFetching={identities.isFetchingNextPage}
            label={t("tracking.resolution.identitiesMore")}
            onLoadMore={identities.loadMore}
          />
        </>
      )}
      <InlineError message={error ? t("tracking.write.error.bindLines") : undefined} />
    </div>
  );
}

function BindDrawer({
  scope,
  item,
  onClose,
}: Readonly<{
  scope: InventoryScope;
  item: ResolutionQueueItem;
  onClose: () => void;
}>): React.JSX.Element {
  const t = useT();
  const write = useBindResolution(item.saleId);
  const [reason, setReason] = useState<BindDraft["reason"]>("");
  const [note, setNote] = useState("");
  const [identities, setIdentities] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<WriteErrors>({});
  const [confirming, setConfirming] = useState(false);
  const lineIds = item.unresolvedLines.map((line) => line.saleLineId);
  const draft: BindDraft = { reason, note, identities };
  const recorded = write.outcome?.kind === "recorded";

  function ask(event: React.FormEvent): void {
    event.preventDefault();
    const found = validateBind(draft, lineIds);
    setErrors(found);
    if (Object.keys(found).length === 0) setConfirming(true);
  }

  async function bind(): Promise<void> {
    setConfirming(false);
    await write.submit(buildBindCommand(draft, lineIds));
  }

  return (
    <Drawer
      title={t("tracking.resolution.drawer.title")}
      scope={t.rich("tracking.resolution.drawer.scope", { sale: <Machine value={item.saleId} /> })}
      onClose={onClose}
      dismissible={!write.pending}
    >
      <form className="surface__form" onSubmit={ask} noValidate data-testid="tracking-bind-form">
        <p className="tracking__muted">{t("tracking.resolution.drawer.sensitive")}</p>
        {item.unresolvedLines.map((line) => (
          <LineBinding
            key={line.saleLineId}
            scope={scope}
            line={line}
            value={identities[line.saleLineId] ?? ""}
            error={Boolean(errors.lines) && !identities[line.saleLineId]}
            onChange={(identityId) =>
              setIdentities((prev) => ({ ...prev, [line.saleLineId]: identityId }))
            }
          />
        ))}
        <ReasonFields
          idPrefix="bind"
          reason={reason}
          note={note}
          errors={errors}
          onReason={setReason}
          onNote={setNote}
          noteAlwaysRequired
        />
        <WriteResult
          outcome={write.outcome}
          recorded={t("tracking.resolution.recorded", { count: lineIds.length })}
          notFoundHint="tracking.write.hint.bindNotFound"
        />
        {confirming && !recorded ? (
          <fieldset className="tracking__confirm">
            <legend>{t("tracking.resolution.confirm", { count: lineIds.length })}</legend>
            <div className="tracking__actions">
              <button type="button" className="btn-destructive" onClick={bind}>
                {t("tracking.resolution.confirmYes")}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
                {t("tracking.write.cancel")}
              </button>
            </div>
          </fieldset>
        ) : (
          <DrawerActions
            recorded={recorded}
            pending={write.pending}
            submitLabel={t("tracking.resolution.submit")}
            onClose={onClose}
          />
        )}
      </form>
    </Drawer>
  );
}
