/**
 * RT-1329: the loading, error and empty states shared by the two lists of the
 * POS pilot page. A 429 is said here once, with one gated retry, and claimed so
 * the shell's shared banner skips it (RT-931). A 403 is "not permitted", never a
 * generic failure.
 */
import { Banner } from "@/components/Banner";
import { PanelBody } from "@/components/DetailPanel";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import { useClaimRateLimit } from "../rateLimitOwner";
import type { PilotReadError } from "./usePosPilot";

export interface PilotList<I> {
  items: I[] | undefined;
  isLoading: boolean;
  error: PilotReadError | undefined;
  refetch: () => void;
}

export function PilotListBody<I>({
  list,
  loadingLabel,
  failedMessage,
  emptyMessage,
  emptyHint,
  children,
}: Readonly<{
  list: PilotList<I>;
  loadingLabel: string;
  failedMessage: string;
  emptyMessage: string;
  emptyHint: string;
  children: (items: I[]) => React.ReactNode;
}>): React.JSX.Element {
  const t = useT();
  const { error } = list;
  useClaimRateLimit(error?.kind === "rate-limited" ? error.seq : undefined);

  if (list.isLoading) {
    return (
      <PanelBody>
        <ListState state="loading" label={loadingLabel} />
      </PanelBody>
    );
  }
  if (error) {
    const message =
      error.kind === "rate-limited"
        ? t("posPilot.rateLimited")
        : error.kind === "not-permitted"
          ? t("posPilot.notPermitted")
          : failedMessage;
    return (
      <PanelBody>
        <Banner
          variant={error.kind === "rate-limited" ? "warning" : "danger"}
          message={message}
          requestId={error.kind === "failed" ? error.requestId : undefined}
          action={
            <GatedButton className="btn-secondary" onClick={list.refetch}>
              {t("posPilot.retry")}
            </GatedButton>
          }
        />
      </PanelBody>
    );
  }
  const items = list.items ?? [];
  if (items.length === 0) {
    return (
      <PanelBody>
        <ListState state="empty" emptyMessage={emptyMessage} emptyHint={emptyHint} />
      </PanelBody>
    );
  }
  return <>{children(items)}</>;
}
