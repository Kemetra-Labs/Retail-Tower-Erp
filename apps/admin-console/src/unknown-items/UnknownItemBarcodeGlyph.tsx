/**
 * RT-1117 (v9 board `Unknown-items`): the small barcode mark before a barcode
 * identifier. Decorative only: it is aria-hidden and carries no text, so the
 * cell's accessible name stays the identifier value. The bar heights come from
 * the digits (the board's rule), so one value always draws the same mark. The
 * bars are plain boxes, not an <svg>: the icon grammar keeps raw SVG to the
 * icon registry.
 */

const BAR_COUNT = 12;
const HEIGHT = 16;

/** Bar heights from the value's digits: every third bar is full height. */
export function barcodeBars(value: string): number[] {
  const digits = value.replace(/\D/g, "").split("");
  return [...digits, ...[...digits].reverse()]
    .slice(0, BAR_COUNT)
    .map((d, i) => (i % 3 === 0 ? HEIGHT : Math.round(HEIGHT * (0.55 + (Number(d) % 5) * 0.09))));
}

export function UnknownItemBarcodeGlyph({
  value,
}: Readonly<{ value: string }>): React.JSX.Element | null {
  const bars = barcodeBars(value);
  if (bars.length === 0) return null;
  return (
    <span className="unknown-item-barcode" aria-hidden="true">
      {bars.map((h, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars are a fixed, positional drawing.
          key={i}
          className="unknown-item-barcode__bar"
          style={{ blockSize: `${String(h)}px` }}
        />
      ))}
    </span>
  );
}
