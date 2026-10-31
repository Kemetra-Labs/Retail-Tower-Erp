/**
 * RT-1012 (DESIGN.md v4.0 §12.6 "Avatars"): a store's initial on an Ink tile in
 * Mint. Pure decoration: `aria-hidden`, so the adjacent name stays the only
 * accessible name of the row or the page. The letter is drawn by CSS from
 * `data-initial`, so it is not text of the cell: a row's text, a sort key or a
 * copy-paste of the table is the name alone. The initial is the name's first
 * grapheme (never half of a surrogate pair or a joined Arabic letter) and no
 * word is stripped from it: a prefix such as «فرع» is a naming habit, not a rule.
 */
import "./stores.css";

/** One segmenter for the page, made on first use; absent in a runtime without `Intl.Segmenter`. */
let segmenter: Intl.Segmenter | null | undefined;

function firstGrapheme(text: string): string {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (!segmenter) return Array.from(text)[0] ?? "?";
  const first = segmenter.segment(text)[Symbol.iterator]().next();
  return first.done ? "?" : first.value.segment;
}

/**
 * The first user-perceived character of a store name, or `?` for a blank name.
 * Upper-cased without the device locale (the product locale beats the device).
 */
export function storeInitial(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? firstGrapheme(trimmed).toUpperCase() : "?";
}

export function StoreInitials({
  name,
  size = "sm",
}: Readonly<{ name: string | undefined; size?: "sm" | "lg" }>): React.JSX.Element {
  return (
    <span
      className={`store-initials store-initials--${size}`}
      aria-hidden="true"
      data-initial={storeInitial(name)}
    />
  );
}
