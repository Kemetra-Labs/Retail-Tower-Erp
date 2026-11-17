/**
 * A failure or warning banner with an optional «try again» action: the shape the owner's force-action
 * dialogs (RT-1440 close-without-a-count, RT-1441 store deletion) share for a refused answer that can
 * be resent and for an unclear answer. `message` is already-translated copy; the request id is the
 * support handle (VD-4).
 */
import { Banner, type BannerVariant } from "@/components/Banner";

export interface FailureBannerProps {
  variant: Extract<BannerVariant, "danger" | "warning">;
  message: string;
  requestId?: string;
  /** The resend, when one is offered. */
  retry?: { label: string; onClick: () => void };
}

export function FailureBanner({
  variant,
  message,
  requestId,
  retry,
}: Readonly<FailureBannerProps>): React.JSX.Element {
  return (
    <Banner
      variant={variant}
      message={message}
      requestId={requestId}
      action={
        retry ? (
          <button type="button" className="btn-secondary" onClick={retry.onClick}>
            {retry.label}
          </button>
        ) : undefined
      }
    />
  );
}
