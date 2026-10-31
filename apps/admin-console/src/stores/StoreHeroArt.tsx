/**
 * RT-1012 (D-V4): the storefront line drawing at the inline end of the store
 * detail band. Pure ornament: it carries no data, is `aria-hidden`, drawn at
 * most 55% opaque, and hidden on narrow screens and under forced colours. The
 * drawing itself is a CSS mask in `stores.css` painted in the band's Mint, so
 * the component is one empty element (the icon rule keeps `<svg>` out of
 * product code).
 */
import "./stores.css";

export function StoreHeroArt(): React.JSX.Element {
  return <span className="store-hero__art" aria-hidden="true" />;
}
