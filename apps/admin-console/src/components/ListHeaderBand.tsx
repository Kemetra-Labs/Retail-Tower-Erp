/**
 * RT-995 (D-V9, DESIGN.md v4.0 §12.6): the Ink header band of a list page, the
 * variant of `PageHeader` a list route renders first. One band per list page.
 *
 * It holds only what D-V9 allows:
 * - the navigation-group label (`group`), the page's one `<h1>` and a one-line
 *   scope `subtitle`;
 * - the page's `actions`, with the single primary drawn as a Mint fill with Ink
 *   text (Mint is a highlight on Ink only, D-V2);
 * - at most three `facts`, each a value the server serves for the WHOLE set. A
 *   full, unpaged list may show its counts; a paged list shows its scope and
 *   period instead, never "loaded so far" dressed up as a total. A page with no
 *   such fact passes none.
 *
 * Filters, banners, errors and every state stay below the band, and the band
 * never changes colour with page state (Brand Yields to Truth), so it takes no
 * children and no state prop. At most 132px tall at 1280px; below 640px it is a
 * plain light header and the ornament is hidden (`list-header-band.css`).
 *
 * It is `PageHeader` with the `band` variant, so the title keeps every header
 * behaviour (the only `<h1>`, the document title, focus after a navigation,
 * `titleRef`/`titleId`) from the one place that defines them.
 */
import { PageHeader, type PageHeaderBand } from "@/components/PageHeader";
import "./list-header-band.css";

export type { BandFact, BandFacts } from "@/components/PageHeader";

export interface ListHeaderBandProps {
  /** The navigation-group label ("Operations", "Integration", "Management"). */
  group: string;
  title: React.ReactNode;
  /** One muted line naming the scope (the tenant, the store). */
  subtitle?: React.ReactNode;
  /** The page's buttons and links: at most one primary. */
  actions?: React.ReactNode;
  /** Server-served facts for the whole set, with the label that names them. */
  facts?: PageHeaderBand["facts"];
  titleRef?: React.Ref<HTMLHeadingElement>;
  titleId?: string;
}

export function ListHeaderBand({
  group,
  facts,
  ...header
}: Readonly<ListHeaderBandProps>): React.JSX.Element {
  return <PageHeader {...header} band={{ group, facts }} />;
}
