/**
 * RT-1509: `/catalog/import/:batchId/:step?`, steps 2 to 7. The step comes from the batch the server
 * returned, never from client state: the URL segment is honoured only when the batch's state allows
 * it (`resolveStep`), so a reload returns to the same step and a stale link lands where the server
 * says. Every write puts its answer in the batch cache; the page decides nothing.
 */
import { Banner } from "@/components/Banner";
import { ListState } from "@/components/ListState";
import { formatNumber, useT } from "@/i18n";
import type { CatalogImportBatch } from "@/lib/catalog-import-queries";
import type { Read } from "@/lib/server-read";
import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { CancelImportDialog } from "./CancelImportDialog";
import { BackToUpload, ImportFrame } from "./ImportFrame";
import { MapStep } from "./MapStep";
import { PreviewStep } from "./PreviewStep";
import { type ResultFromPublish, ResultStep } from "./ResultStep";
import { ReviewStep } from "./ReviewStep";
import { ValidateStep } from "./ValidateStep";
import {
  type ImportStep,
  type RoutedStep,
  isClosedUnpublished,
  resolveStep,
  undecidedCount,
} from "./catalogImportLogic";
import type { ImportNotice, StepProps } from "./stepTypes";
import { useBatchCache, useImportBatch } from "./useCatalogImport";
import { usePublishFlow } from "./usePublishFlow";

/** What shows while the batch is not there to work on: loading, a failed read, or a closed batch. */
function Gate({
  read,
  batch,
}: Readonly<{ read: Read<CatalogImportBatch>; batch: CatalogImportBatch | undefined }>) {
  const t = useT();
  if (!batch && read.isLoading) {
    return (
      <ImportFrame step="map">
        <ListState state="loading" label={t("catalogImport.loading")} />
      </ImportFrame>
    );
  }
  if (!batch) {
    const gone = read.error?.kind === "not-available";
    return (
      <ImportFrame step="map">
        <Banner
          variant="danger"
          title={gone ? undefined : t("catalogImport.loadFailed.title")}
          message={t(gone ? "catalogImport.error.notAvailable" : "catalogImport.loadFailed.body")}
          requestId={read.error?.requestId}
          action={
            gone ? undefined : (
              <button type="button" className="btn-secondary" onClick={read.refetch}>
                {t("catalogImport.reload")}
              </button>
            )
          }
        />
        <BackToUpload />
      </ImportFrame>
    );
  }
  return (
    <ImportFrame step="upload">
      <Banner
        variant="info"
        title={t("catalogImport.closed.title")}
        message={t("catalogImport.closed.body")}
      />
      <BackToUpload />
    </ImportFrame>
  );
}

function StepSwitch({
  step,
  props,
  fromPublish,
}: Readonly<{ step: RoutedStep; props: StepProps; fromPublish: ResultFromPublish | null }>) {
  const { batch } = props;
  switch (step) {
    case "map":
      return <MapStep key={`${batch.version}-${batch.state}`} {...props} />;
    case "validate":
      return <ValidateStep {...props} />;
    case "review":
      return <ReviewStep {...props} />;
    case "preview":
      return <PreviewStep {...props} />;
    default:
      return <ResultStep batch={batch} fromPublish={fromPublish} />;
  }
}

/** The fact each step adds to its node in the strip. */
function useStepFacts(batch: CatalogImportBatch | undefined): Partial<Record<RoutedStep, string>> {
  const t = useT();
  if (!batch) return {};
  return {
    map: t("catalogImport.stepFact.columns", { count: formatNumber(batch.columns.length) }),
    validate: t("catalogImport.stepFact.rows", { count: formatNumber(batch.file.dataRowCount) }),
    review: t("catalogImport.stepFact.undecided", {
      count: formatNumber(undecidedCount(batch.counts)),
    }),
  };
}

export function CatalogImportWorkspace(): React.JSX.Element {
  const { batchId, step: requested } = useParams();
  const navigate = useNavigate();
  const read = useImportBatch(batchId);
  const cache = useBatchCache(batchId);
  const [notice, setNotice] = useState<ImportNotice | null>(null);
  const [run, setRun] = useState(0);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [fromPublish, setFromPublish] = useState<ResultFromPublish | null>(null);

  const go = (to: RoutedStep): void => void navigate(`/catalog/import/${batchId}/${to}`);
  const publish = usePublishFlow({
    batchId: batchId ?? "",
    reread: cache.reread,
    onPublished: (batch, summary, replayed) => {
      cache.store(batch);
      setFromPublish(summary ? { summary, replayed } : null);
      go("result");
    },
    onRouted: ({ notice: next, step }) => {
      setNotice(next);
      if (step) go(step);
    },
  });

  const batch = read.data;
  const step = batch ? resolveStep(batch, requested) : null;
  const facts = useStepFacts(batch);
  if (!batchId || !batch || isClosedUnpublished(batch) || step === null) {
    return <Gate read={read} batch={batch} />;
  }
  if (requested !== step) {
    // The frame stays mounted while the URL catches up, so focus lands on the step's heading.
    return (
      <ImportFrame step={step}>
        <Navigate to={`/catalog/import/${batchId}/${step}`} replace />
      </ImportFrame>
    );
  }

  const locked =
    publish.phase === "pending" || publish.phase === "unclear" || publish.phase === "refreshing";
  const props: StepProps = {
    batch,
    cache,
    go,
    notice,
    setNotice,
    requestCancel: () => setCancelOpen(true),
    run,
    bumpRun: () => setRun((n) => n + 1),
    locked,
    publish,
  };
  const current: ImportStep = publish.dialogOpen || locked ? "publish" : step;
  return (
    <ImportFrame
      step={current}
      currentFact={current === "publish" ? undefined : facts[step]}
      needsValidation={step === "validate" && batch.state === "draft"}
    >
      <StepSwitch step={step} props={props} fromPublish={fromPublish} />
      {cancelOpen ? (
        <CancelImportDialog
          batch={batch}
          onClose={() => setCancelOpen(false)}
          onStale={() => void cache.reread()}
          onCancelled={() => {
            setCancelOpen(false);
            void navigate("/catalog/import");
          }}
        />
      ) : null}
    </ImportFrame>
  );
}
