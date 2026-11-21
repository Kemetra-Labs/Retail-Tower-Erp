/** RT-1509: what every routed step of the workspace receives. */
import type { CatalogImportBatch } from "@/lib/catalog-import-queries";
import type { RoutedStep } from "./catalogImportLogic";
import type { useBatchCache } from "./useCatalogImport";
import type { PublishFlow } from "./usePublishFlow";

/** A notice the workspace keeps until the merchant acts on it (never a toast). */
export type ImportNotice = "stale" | "replaced" | "previewChanged" | "notPublishable";

export interface StepProps {
  batch: CatalogImportBatch;
  cache: ReturnType<typeof useBatchCache>;
  go: (step: RoutedStep) => void;
  notice: ImportNotice | null;
  setNotice: (notice: ImportNotice | null) => void;
  /** Opens the cancel dialog («إلغاء الاستيراد»). */
  requestCancel: () => void;
  /** Counts each validation run; row pages restart when it changes (the cursor is bound to it). */
  run: number;
  bumpRun: () => void;
  /** A publish whose outcome is unknown holds every other action (D9). */
  locked: boolean;
  publish: PublishFlow;
}
