/**
 * Persistent status banner (T011, FR-003-007, VD-4). DESIGN.md rule 4:
 * persistent banners, not toasts. Surfaces the backend `request_id` so an
 * operator can quote it to support (exact and LTR-isolated, RT-399). Never
 * auto-dismisses. `message` is already-translated copy.
 *
 * RT-963 (WCAG 4.1.3): the live-region role follows the severity. Danger and
 * warning interrupt (`alert`); success and info wait their turn (`status`).
 * A `status` region inserted already populated is often not announced, so it
 * mounts empty and its content lands on the next task, inside a region the
 * screen reader already tracks.
 */
import { useT } from "@/i18n";
import { useEffect, useState } from "react";
import "./banner.css";

export type BannerVariant = "danger" | "warning" | "success" | "info";

export interface BannerProps {
  variant: BannerVariant;
  /** Optional one-line headline above `message` (already-translated copy). */
  title?: string;
  message: string;
  /** Backend request_id from a 4xx response (VD-4). Rendered when present. */
  requestId?: string;
  /**
   * Optional inline action (e.g. a Retry button for a retryable 5xx). Rendered
   * at the end of the banner. RF-1 callers omit it; RF-2 list surfaces pass a
   * retry that refetches the query (design-brief §6 "Retry").
   */
  action?: React.ReactNode;
}

const ROLE: Record<BannerVariant, "alert" | "status"> = {
  danger: "alert",
  warning: "alert",
  success: "status",
  info: "status",
};

export function Banner(props: Readonly<BannerProps>): React.JSX.Element {
  const role = ROLE[props.variant];
  // RT-978: keyed by the role, so a banner whose severity crosses between alert
  // and status is a new live-region element (not a role flip on a live one) and
  // re-runs its empty first commit.
  return <BannerRegion key={role} role={role} {...props} />;
}

function BannerRegion({
  role,
  variant,
  title,
  message,
  requestId,
  action,
}: Readonly<BannerProps & { role: "alert" | "status" }>): React.JSX.Element {
  const t = useT();
  const filled = useFilledAfterMount(role === "alert");
  return (
    <div className={`rtc-alert rtc-alert--${variant}`} role={role}>
      {filled ? (
        <>
          {title ? <strong className="rtc-alert__title">{title}</strong> : null}
          <span className={title ? "rtc-alert__body" : "rtc-alert__msg"}>{message}</span>
          {requestId ? (
            <span className="rtc-alert__req">
              {t.rich("components.banner.requestRef", { id: <bdi dir="ltr">{requestId}</bdi> })}
            </span>
          ) : null}
          {action ? <span className="rtc-alert__action">{action}</span> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * False on the first commit, then true on the next task. A timer, not a bare
 * effect: React flushes effects of a click-driven render before paint, which
 * would insert the region populated after all.
 */
function useFilledAfterMount(immediately: boolean): boolean {
  const [filled, setFilled] = useState(immediately);
  useEffect(() => {
    if (filled) return;
    const id = window.setTimeout(() => setFilled(true), 0);
    return () => window.clearTimeout(id);
  }, [filled]);
  return filled;
}
