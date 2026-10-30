/**
 * RT-991 (DESIGN.md v4.0 §12.2): the brand mark, three ascending bars on a
 * Mint-to-teal tile. Decorative: the product word beside it names the product, so
 * the mark is hidden from assistive technology. Drawn in CSS (`app-shell.css`),
 * from role tokens only.
 */
export function BrandMark(): React.JSX.Element {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-mark__bar" />
      <span className="brand-mark__bar" />
      <span className="brand-mark__bar" />
    </span>
  );
}
