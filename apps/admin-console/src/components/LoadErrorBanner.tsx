/**
 * RT-965: the persistent banner for a failed list or detail load. What failed is the title; the
 * body gives the cause and says nothing was changed; the retry control appears only when a retry
 * can help; the request reference is the evidence (`Banner` renders it LTR-isolated).
 */
import { useT } from "@/i18n";
import type { LoadFailure } from "@/lib/error-recovery";
import { Banner } from "./Banner";
import { loadFailureDetail } from "./loadFailureCopy";

export function LoadErrorBanner({
  what,
  failure,
  retryLabel,
  onRetry,
}: Readonly<{
  /** Already-translated: what could not be loaded. */
  what: string;
  failure: LoadFailure;
  retryLabel: string;
  onRetry: () => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <Banner
      variant="danger"
      title={what}
      message={loadFailureDetail(t, failure)}
      requestId={failure.requestId}
      action={
        failure.retryable ? (
          <button type="button" className="btn-secondary" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : undefined
      }
    />
  );
}
