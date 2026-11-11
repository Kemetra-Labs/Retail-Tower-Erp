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

function ReadError({
  error,
  failedMessage,
  onRetry,
}: Readonly<{ error: PilotReadError; failedMessage: string; onRetry: () => void }>) {
  const t = useT();
  if (error.kind === "not-permitted") {
    // A retry cannot help a 403 (UX-12.8).
    return (
      <PanelBody>
        <Banner variant="danger" message={t("posPilot.notPermitted")} />
      </PanelBody>
    );
  }
  const limited = error.kind === "rate-limited";
  return (
    <PanelBody>
      <Banner
        variant={limited ? "warning" : "danger"}
        message={limited ? t("posPilot.rateLimited") : failedMessage}
        requestId={limited ? undefined : error.requestId}
        action={
          <GatedButton className="btn-secondary" onClick={onRetry}>
            {t("posPilot.retry")}
          </GatedButton>
        }
      />
    </PanelBody>
  );
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
    return <ReadError error={error} failedMessage={failedMessage} onRetry={list.refetch} />;
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
