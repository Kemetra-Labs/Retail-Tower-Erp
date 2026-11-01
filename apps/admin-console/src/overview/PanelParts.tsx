/**
 * RT-970 the Overview v2 panel states (RT-970 "Panel states"): a skeleton while
 * a read is in flight, an in-panel error with its request id and a retry, and a
 * labelled «غير متاح» where there is no source. Never a zero in their place.
 */
import { Icon } from "@/components/icons/Icon";
import { useT } from "@/i18n";
import type { DeltaTone } from "@/metrics/metricRegistry";
import type { Trend } from "./glanceLogic";

/** Placeholder bars while a read is in flight; announced once, politely. */
export function PanelSkeleton({ lines = 3 }: Readonly<{ lines?: number }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="glance-skeleton" aria-busy="true">
      <span className="sr-only">{t("overview.row.loading")}</span>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
        <span key={i} className="glance-skeleton__bar" aria-hidden="true" />
      ))}
    </div>
  );
}

/**
 * What failed, that nothing changed, the retry, and the request reference.
 * `announce` false for a second panel over the same failed read, so assistive
 * tech hears the failure once.
 */
export function PanelError({
  requestId,
  retry,
  announce = true,
}: Readonly<{ requestId?: string; retry: () => void; announce?: boolean }>): React.JSX.Element {
  const t = useT();
  return (
    <div className="glance-error" role={announce ? "alert" : undefined}>
      <span>{t("overview.panel.failed")}</span>
      {requestId ? (
        <span className="glance-error__ref">
          {t.rich("components.banner.requestRef", { id: <bdi dir="ltr">{requestId}</bdi> })}
        </span>
      ) : null}
      <button type="button" className="btn-secondary" onClick={retry}>
        {t("overview.panel.retry")}
      </button>
    </div>
  );
}

/** No source for this figure (a refused read, or no read exists): never 0. */
export function Unavailable(): React.JSX.Element {
  const t = useT();
  return <span className="glance-unavailable">{t("overview.unavailable")}</span>;
}

const TREND_KEY = {
  up: "overview.kpi.up",
  down: "overview.kpi.down",
  same: "overview.kpi.same",
} as const;

/**
 * Today against the previous business day: the arrow, the signed value and the
 * named baseline in words (owner decision, RT-993 comment 15088), never colour
 * alone (UX-13). `tone` is the metric's good-direction judgement
 * (`metricRegistry.ts`, DESIGN.md §12.8.2), not the arrow; it only tints the
 * chip that already says the same thing.
 */
export function Delta({
  trend,
  previous,
  signed,
  tone,
}: Readonly<{
  trend: Trend;
  previous: React.ReactNode;
  /** The signed difference, formatted (`+7,318.50 EGP`, `-2`). */
  signed?: React.ReactNode;
  tone: DeltaTone;
}>): React.JSX.Element {
  const t = useT();
  if (trend === "unknown") {
    return (
      <span className="glance-delta" data-tone="neutral">
        {t("overview.kpi.previousUnknown")}
      </span>
    );
  }
  return (
    <span className="glance-delta" data-tone={tone}>
      <span className="glance-delta__chip">
        {trend === "same" ? null : (
          <Icon
            name={trend === "up" ? "increase" : "decrease"}
            size="sm"
            className="glance-delta__icon"
          />
        )}
        {signed}
      </span>
      <span>{t.rich(TREND_KEY[trend], { value: previous })}</span>
    </span>
  );
}
