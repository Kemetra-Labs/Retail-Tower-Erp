/**
 * RT-1515 (PR 1) shared pieces of the shipment-Transfer views: the state and
 * ERP-leg pills (text carries the meaning, colour only reinforces), a store
 * named from the tenant's store list (its id, LTR-isolated, until the list
 * answers or when the store is not listed), and the read error, keyed by the
 * envelope's `error.code` before the HTTP status.
 */
import { TableScrollRegion } from "@/components/DataTableScroll";
import { type MessageKey, useT } from "@/i18n";
import { useStoreList } from "@/stores/useStoreQueries";
import { Machine, ReadError } from "../parts";
import type { InventoryError } from "../useInventory";
import {
  legStateKey,
  legStateTone,
  transferErrorOf,
  transferStateKey,
  transferStateTone,
} from "./transferLogic";

export function StateBadge({ state }: Readonly<{ state: string }>): React.JSX.Element {
  const t = useT();
  return (
    <span className={`badge ${transferStateTone(state)}`.trim()}>{t(transferStateKey(state))}</span>
  );
}

export function LegBadge({
  state,
}: Readonly<{ state: string | null | undefined }>): React.JSX.Element {
  const t = useT();
  return <span className={`badge ${legStateTone(state)}`.trim()}>{t(legStateKey(state))}</span>;
}

/** Store id → name, from the tenant's store list once it has loaded. */
export function useStoreNames(tenantId: string | null): ReadonlyMap<string, string> {
  const { result } = useStoreList(tenantId);
  const rows = result?.kind === "rows" ? result.rows : [];
  return new Map(rows.filter((s) => s.name).map((s) => [s.id, s.name as string]));
}

export function StoreName({
  id,
  names,
}: Readonly<{ id: string; names: ReadonlyMap<string, string> }>): React.JSX.Element {
  const name = names.get(id);
  // Not listed (or the list has not answered): the id, as machine data.
  if (name === undefined) return <Machine value={id} />;
  return <bdi dir="auto">{name}</bdi>;
}

/** A captioned strip table in its own scroll region (every Transfer table). */
export function CaptionedTable({
  caption,
  strips = true,
  children,
}: Readonly<{ caption: string; strips?: boolean; children: React.ReactNode }>): React.JSX.Element {
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className={strips ? "data-table data-table--strips" : "data-table"}>
          <caption id={captionId} className="data-table__caption">
            {caption}
          </caption>
          {children}
        </table>
      )}
    </TableScrollRegion>
  );
}

/** A read that failed with nothing on screen: copy by `error.code`, with the request id. */
export function TransferError({
  error,
  failedKey,
  notFoundKey = "transfers.notFound",
  onRetry,
}: Readonly<{
  error: InventoryError;
  failedKey: MessageKey;
  notFoundKey?: MessageKey;
  onRetry: () => void;
}>): React.JSX.Element {
  return (
    <ReadError
      error={transferErrorOf(error)}
      failedKey={failedKey}
      notFoundKey={notFoundKey}
      onRetry={onRetry}
    />
  );
}
