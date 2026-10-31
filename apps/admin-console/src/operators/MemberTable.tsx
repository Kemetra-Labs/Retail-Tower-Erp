import { Avatar } from "@/components/Avatar";
import { OpenCell, OpenHeader } from "@/components/DataTableParts";
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { type T, roleKey, useT } from "@/i18n";
import "@/components/avatar.css";
import "@/components/data-table.css";
/**
 * RT-1014 (v4.0 Users): the member roster as one table whose body is split into
 * a `<tbody>` per role, each opened by a group header row (`<th scope="rowgroup">`
 * with the role and its count). `DataTable` has no group rows, so this keeps its
 * markup and classes: one caption, one set of column headers, the explicit «Open»
 * button first in every row and named for the member (RT-963, RT-978), so every
 * member stays reachable by a name that tells same-named members apart.
 *
 * The cells are today's: identity (name over mono email), role, store access as
 * a count (names are not served, OQ-3) and the membership state.
 */
import { groupMembers, memberOpenName } from "./memberGroups";
import type { MemberRow } from "./useMembers";
import "./users.css";

/** At most five bars: a glance at how many stores, with the count as text beside it. */
const BAR_COUNT = 5;

interface MemberColumn {
  key: string;
  header: string;
  cell: (row: MemberRow) => React.ReactNode;
}

function storeAccessLabel(row: MemberRow, t: T): string {
  if (row.storeAccessKind === "all") return t("operators.storeAccess.all");
  return t("operators.storeAccess.count", { count: row.accessibleStoreIds.length });
}

/** The access meter: decoration only, the same fact is the text beside it. */
function AccessBars({ row }: Readonly<{ row: MemberRow }>): React.JSX.Element {
  const lit =
    row.storeAccessKind === "all" ? BAR_COUNT : Math.min(row.accessibleStoreIds.length, BAR_COUNT);
  return (
    <span className="member-access__bars" aria-hidden="true">
      {Array.from({ length: lit }, (_, i) => (
        // The position is the only identity a bar has.
        // biome-ignore lint/suspicious/noArrayIndexKey: static, order-only decoration
        <i key={i} />
      ))}
    </span>
  );
}

function memberColumns(t: T): MemberColumn[] {
  return [
    {
      key: "member",
      header: t("operators.list.col.member"),
      cell: (row) => (
        <span className="member-cell">
          <Avatar name={row.displayName ?? row.email} size={36} />
          <span className="member-identity">
            <span className="member-identity__name">{row.displayName ?? row.email}</span>
            {row.displayName ? (
              <span className="member-identity__email">
                <bdi dir="ltr">{row.email}</bdi>
              </span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: "role",
      header: t("operators.list.col.role"),
      cell: (row) => {
        const key = roleKey(row.roleCode);
        return (
          <span
            className={key === "role.unknown" ? "member-role member-role--unknown" : "member-role"}
          >
            {t(key)}
          </span>
        );
      },
    },
    {
      key: "storeAccess",
      header: t("operators.list.col.storeAccess"),
      cell: (row) => (
        <span className="member-access">
          <AccessBars row={row} />
          {storeAccessLabel(row, t)}
        </span>
      ),
    },
    {
      key: "state",
      header: t("operators.list.col.state"),
      cell: (row) =>
        row.revoked ? (
          <span className="badge badge--warning">{t("operators.state.revoked")}</span>
        ) : (
          <span className="badge badge--success">{t("operators.state.active")}</span>
        ),
    },
  ];
}

export function MemberTable({
  rows,
  onOpen,
}: Readonly<{ rows: readonly MemberRow[]; onOpen: (row: MemberRow) => void }>): React.JSX.Element {
  const t = useT();
  const captionId = useCaptionId();
  const columns = memberColumns(t);
  return (
    <DataTableScroll captionId={captionId}>
      <table className="data-table member-table">
        <caption id={captionId} className="data-table__caption">
          {t("operators.list.caption")}
        </caption>
        <thead>
          <tr>
            <OpenHeader />
            {columns.map((col) => (
              <th key={col.key} scope="col">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        {groupMembers(rows).map((group) => (
          <tbody key={group.key}>
            <tr className="member-group">
              <th scope="rowgroup" colSpan={columns.length + 1}>
                <span className="member-group__name">{t(group.key)}</span>
                {/* Text between the name and the count, so a screen reader does not run them together. */}
                <span className="sr-only">: </span>
                <span className="member-group__count">{group.rows.length}</span>
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr
                key={row.membershipId}
                className={
                  row.revoked
                    ? "data-table__row data-table__row--static member-row member-row--revoked"
                    : "data-table__row data-table__row--static member-row"
                }
              >
                <OpenCell label={memberOpenName(row)} onOpen={() => onOpen(row)} />
                {columns.map((col) => (
                  <td key={col.key}>{col.cell(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </DataTableScroll>
  );
}
