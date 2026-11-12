/**
 * RT-455 shared pieces for the tracking screens: the names a screen resolves
 * (products from the catalog detail read, stores from the store list, actors
 * from `listMembers`; TR-7, OD-3), the reason and hold-kind labels, and
 * the «قريبًا» frame for the tabs whose contract has no route yet.
 *
 * A name is a convenience, never a dependency: until it resolves, the id stays
 * (machine data, LTR-isolated); an actor that is not a member reads as the
 * fallback label with its id.
 */
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { formatDateTime, useT } from "@/i18n";
import { createContext, useContext } from "react";
import { Machine } from "../inventory/parts";
import { type MemberName, actorLabel, holdKindKey, reasonKey } from "./trackingLogic";
import { useProductNames } from "./useTracking";

export interface TrackingNames {
  storeName: (id: string) => string | null;
  /** Undefined when the members were not read (no role, still loading, failed). */
  members: readonly MemberName[] | undefined;
}

const NamesContext = createContext<TrackingNames>({
  storeName: () => null,
  members: undefined,
});

export const TrackingNamesProvider = NamesContext.Provider;

function useNames(): TrackingNames {
  return useContext(NamesContext);
}

/**
 * A product by its catalog name (TR-7), read once per product and shared by every
 * row that names it (the query cache dedupes); its id until the name resolves.
 */
export function ProductName({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const { context } = useActiveContextValue();
  const name = useProductNames(context?.active_tenant?.id ?? null, [id]).get(id);
  if (!name) return <Machine value={id} />;
  return <bdi className="tracking__name">{name}</bdi>;
}

export function StoreName({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const name = useNames().storeName(id);
  return name ? <bdi className="tracking__name">{name}</bdi> : <Machine value={id} />;
}

/** The stores a held identity has stock in; none reads «لا مخزون». */
export function StoreList({ ids }: Readonly<{ ids: readonly string[] }>): React.JSX.Element {
  const t = useT();
  if (ids.length === 0) return <span className="tracking__muted">{t("tracking.stores.none")}</span>;
  return (
    <ul className="tracking__stores">
      {ids.map((id) => (
        <li key={id}>
          <StoreName id={id} />
        </li>
      ))}
    </ul>
  );
}

/** OD-3: a member's name; else the fallback label with the id (former member, or unread). */
export function ActorName({ userId }: Readonly<{ userId: string }>): React.JSX.Element {
  const t = useT();
  const label = actorLabel(useNames().members, userId);
  if (label) return <bdi className="tracking__name">{label}</bdi>;
  return (
    <span className="tracking__actor-fallback">
      {t("tracking.actor.unknown")} <Machine value={userId} />
    </span>
  );
}

/** A stored reason: its label when it is one of the fixed list, else the code as sent. */
export function ReasonLabel({ code }: Readonly<{ code: string }>): React.JSX.Element {
  const t = useT();
  const key = reasonKey(code);
  return key ? <span>{t(key)}</span> : <Machine value={code} />;
}

export function HoldKindBadge({ kind }: Readonly<{ kind: string }>): React.JSX.Element {
  const t = useT();
  return <span className="badge badge--danger">{t(holdKindKey(kind))}</span>;
}

/** A recorded instant, in UTC with its label (no store zone is known for a tenant-wide record). */
export function When({ iso }: Readonly<{ iso: string }>): React.JSX.Element {
  return <time dateTime={iso}>{formatDateTime(iso)}</time>;
}

/** A calendar date as the API sends it (`YYYY-MM-DD`); none reads «غير مسجّل». */
export function DateValue({ value }: Readonly<{ value: string | null }>): React.JSX.Element {
  const t = useT();
  return value ? <Machine value={value} /> : <span>{t("tracking.date.none")}</span>;
}
