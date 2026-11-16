/**
 * RT-1425 — one Count Session: its status (and, after approval, its ERP status),
 * blind capture, the Count Cut / submit / cancel commands, the variance review with
 * approval and recount, and the late pre-cut findings. Which panels show follows
 * the server's `state`; every refusal is the server's, shown by its typed code.
 *
 * Panel order follows the journey: status, capture (open, cut taken), commands,
 * review (submitted onward), findings. The unit of reading is the whole session:
 * after any recorded write every count read is refetched.
 */
import { ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useT } from "@/i18n";
import { isUuid } from "@/inventory/inventoryLogic";
import { BackLink, ReadError } from "@/inventory/parts";
import { type InventoryScope, useStockLocations } from "@/inventory/useInventory";
import type { CountSession } from "@/lib/count-session-queries";
import { ScopeMismatchBanner } from "@/shell/ScopeMismatchBanner";
import { useState } from "react";
import { useParams } from "react-router";
import { CaptureSection } from "./CaptureSection";
import { CountActions } from "./CountActions";
import { CountGate, StateBadge } from "./CountParts";
import { CountStatusPanel } from "./CountStatusPanel";
import { LateFindingsSection } from "./LateFindingsSection";
import { ReviewSection } from "./ReviewSection";
import { canCapture, hasReview } from "./countLogic";
import {
  useAllVarianceLines,
  useCountSession,
  useLateFindings,
  useProductNames,
} from "./useCounts";
import "../shell/surface.css";
import "../inventory/inventory.css";
import "./counts.css";

/** The product names looked up for one session: bounded, the rest show their id. */
const NAME_LOOKUP_LIMIT = 100;

interface Target {
  scope: InventoryScope;
  storeId: string;
  sessionId: string;
}

function Review({
  target,
  session,
  names,
  locationNames,
  index,
}: Readonly<{
  target: Target;
  session: CountSession;
  names: ReadonlyMap<string, string>;
  locationNames: ReadonlyMap<string, string>;
  index: number;
}>) {
  const lines = useAllVarianceLines(target);
  return (
    <ReviewSection
      session={session}
      lines={lines}
      names={names}
      locationNames={locationNames}
      index={index}
    />
  );
}

function Late({
  target,
  names,
  index,
}: Readonly<{ target: Target; names: ReadonlyMap<string, string>; index: number }>) {
  const findings = useLateFindings(target);
  return <LateFindingsSection findings={findings} names={names} index={index} />;
}

function SessionView({ target, session }: Readonly<{ target: Target; session: CountSession }>) {
  const t = useT();
  const { scope, storeId } = target;
  const locations = useStockLocations({ scope, storeId });
  const [capturing, setCapturing] = useState(false);
  const names = useProductNames(scope, session.scope.productIds.slice(0, NAME_LOOKUP_LIMIT));
  const active = (locations.data?.items ?? []).filter((l) => l.isActive);
  const locationNames = new Map((locations.data?.items ?? []).map((l) => [l.id, l.name || l.code]));
  const capture = canCapture(session.state);
  const review = hasReview(session.state);
  const late = session.lateEventFindingCount > 0;
  let position = 1;
  const next = () => position++;
  return (
    <>
      <ListHeaderBand
        group={t("shell.nav.section.stock")}
        title={t("counts.session.title")}
        subtitle={<StateBadge state={session.state} />}
      />
      <CountStatusPanel session={session} index={next()} />
      {capture ? (
        <CaptureSection
          storeId={storeId}
          session={session}
          names={names}
          locations={active}
          locationsFailed={Boolean(locations.error)}
          onBusyChange={setCapturing}
          index={next()}
        />
      ) : null}
      <CountActions session={session} captureBusy={capturing} index={next()} />
      {review ? (
        <Review
          target={target}
          session={session}
          names={names}
          locationNames={locationNames}
          index={next()}
        />
      ) : null}
      {late ? <Late target={target} names={names} index={next()} /> : null}
    </>
  );
}

function SessionPage({ target }: Readonly<{ target: Target }>): React.JSX.Element {
  const t = useT();
  const session = useCountSession(target);
  let body: React.JSX.Element;
  if (session.isLoading)
    body = <ListState state="loading" label={t("counts.session.loadingNoun")} />;
  else if (session.error || !session.data) {
    body = (
      <ReadError
        error={session.error ?? { kind: "generic" }}
        failedKey="counts.session.loadFailed"
        notFoundKey="counts.session.notFound"
        onRetry={session.retry}
      />
    );
  } else
    body = (
      <SessionView
        key={`${target.scope.tenantId}:${target.storeId}:${target.sessionId}`}
        target={target}
        session={session.data}
      />
    );
  return (
    <div className="surface inventory--v4 counts">
      <BackLink
        to={`/inventory/stores/${target.storeId}/counts`}
        label={t("counts.session.back")}
      />
      <ScopeMismatchBanner storeId={target.storeId} />
      {body}
    </div>
  );
}

export function CountSessionDetail(): React.JSX.Element {
  const { storeId, sessionId } = useParams();
  return (
    <CountGate
      valid={isUuid(storeId) && isUuid(sessionId)}
      storeId={storeId}
      notFoundKey="counts.session.notFound"
    >
      {(scope) => (
        <SessionPage target={{ scope, storeId: storeId ?? "", sessionId: sessionId ?? "" }} />
      )}
    </CountGate>
  );
}
