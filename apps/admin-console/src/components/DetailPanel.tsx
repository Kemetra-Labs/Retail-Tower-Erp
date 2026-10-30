/**
 * RT-961: the v3 detail-page template's parts (DESIGN.md §5, §9).
 *
 * - `DetailPanel` is one data region in a section panel: a region named by its
 *   `h2` panel title, an optional `aside` beside the title (a count, an Add
 *   action), then the content. Content that is not a table goes in
 *   `PanelBody`; a table sits straight under the header, edge to edge. A panel
 *   with no title is a plain container (a tab panel already names it).
 * - `DetailGrid` puts ledger panels two to a row when the content is wide
 *   enough and stacks them otherwise. DOM order is reading order.
 * - `LedgerField` is one label/value row of a ledger `<dl>`: the value at body
 *   size, the label muted and never heavier than the value. `mono` is machine data; `money` is end-aligned with
 *   tabular numerals; `result` and `total` anchor the figures a ledger arrives
 *   at, the total under a strong rule. Status keeps its text label.
 */
import "@/shell/surface.css";

export function DetailPanel({
  id,
  title,
  aside,
  className,
  children,
}: Readonly<{
  id?: string;
  title?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  const classes = className
    ? `section-panel detail-panel ${className}`
    : "section-panel detail-panel";
  if (title === undefined) return <div className={classes}>{children}</div>;
  return (
    <section className={classes} aria-labelledby={id}>
      <div className="section-panel__head">
        <h2 id={id} className="section-panel__title">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function PanelBody({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="section-panel__body">{children}</div>;
}

export function DetailGrid({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="detail-grid">{children}</div>;
}

function rowClass(result?: boolean, total?: boolean): string {
  if (total) return "field-row field-row--total";
  return result ? "field-row field-row--result" : "field-row";
}

function valueClass(mono?: boolean, money?: boolean): string {
  if (money) return "field-row__value field-row__value--money";
  return mono ? "field-row__value field-row__value--mono" : "field-row__value";
}

export function LedgerField({
  label,
  mono,
  money,
  result,
  total,
  children,
}: Readonly<{
  label: React.ReactNode;
  mono?: boolean;
  money?: boolean;
  result?: boolean;
  total?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className={rowClass(result, total)}>
      <dt className="field-row__label">{label}</dt>
      <dd className={valueClass(mono, money)}>{children}</dd>
    </div>
  );
}
