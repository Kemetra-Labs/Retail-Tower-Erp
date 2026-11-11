/**
 * RT-1329: the table frame both lists of the POS pilot page share. A semantic
 * table in the shared keyboard-reachable scroll region (RT-826, RT-963), named
 * by its caption; `num` headers are end-aligned like their cells.
 */
import { TableScrollRegion } from "@/components/DataTableScroll";

export interface PilotColumn {
  key: string;
  label: string;
  num?: boolean;
}

export function PilotTable({
  caption,
  columns,
  children,
}: Readonly<{
  caption: string;
  columns: readonly PilotColumn[];
  children: React.ReactNode;
}>): React.JSX.Element {
  const head = columns.map((c) => (
    <th key={c.key} scope="col" className={c.num ? "num" : undefined}>
      {c.label}
    </th>
  ));
  return (
    <TableScrollRegion>
      {(captionId) => (
        <table className="data-table data-table--strips">
          <caption id={captionId} className="data-table__caption">
            {caption}
          </caption>
          <thead>
            <tr>{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      )}
    </TableScrollRegion>
  );
}
