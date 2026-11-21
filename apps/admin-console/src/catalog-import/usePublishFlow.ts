/**
 * RT-1509 step 6: the publish, as one flow that outlives its dialog.
 *
 * One `Idempotency-Key` is held per intended publish (`KeyedAttempt`, keyed on the body: the version
 * and the `previewHash` the merchant saw). An unclear answer (no answer, 5xx, 425, 429) is never
 * resolved by a new action: it is resent as it was (same key, same body: the server replays a
 * recorded publish) or checked with «تحديث الحالة» (read the batch). Until the state is known the
 * flow reports `unclear`, and the workspace disables cancel, new upload and re-publish (D9), even
 * after the dialog is closed. Nothing here says «published» before the server returned the batch.
 */
import {
  type CatalogImportBatch,
  type CatalogImportPreview,
  type PublishSummary,
  consoleGetCatalogImport,
  consolePublishCatalogImport,
} from "@/lib/catalog-import-queries";
import { KeyedAttempt } from "@/lib/write-outcome";
import { useRef, useState } from "react";
import type { ImportOutcome } from "./catalogImportLogic";
import { outcomeOf, useWait } from "./importParts";
import type { ImportNotice } from "./stepTypes";

type Refused = Extract<ImportOutcome<unknown>, { kind: "refused" }>;
type Unclear = Extract<ImportOutcome<unknown>, { kind: "unclear" }>;

type PublishPhase = "idle" | "pending" | "unclear" | "refreshing";

export interface PublishFlow {
  phase: PublishPhase;
  /** The modal is open. It closes on a terminal answer, or by the merchant; an unclear state outlives it. */
  dialogOpen: boolean;
  open: () => void;
  close: () => void;
  /** The last refusal the dialog shows itself (the others route elsewhere). */
  refusal: Refused | null;
  unclear: Unclear | null;
  /** «لم يُنشر الاستيراد بعد»: the status check found the batch still validated. */
  notPublished: boolean;
  /** Seconds left of a server-given wait (425, 429) before a resend is offered. */
  wait: number;
  /** A preview read again after `preview_changed` or a version conflict. */
  revision: number;
  publish: (preview: CatalogImportPreview) => Promise<void>;
  resend: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface Hooks {
  batchId: string;
  onPublished: (
    batch: CatalogImportBatch,
    summary: PublishSummary | null,
    replayed: boolean,
  ) => void;
  /** The server answered a terminal refusal that moves the merchant elsewhere. */
  onRouted: (route: { notice: ImportNotice | null; step: "validate" | "preview" | null }) => void;
  reread: () => Promise<void>;
}

export function usePublishFlow({ batchId, onPublished, onRouted, reread }: Hooks): PublishFlow {
  const attempt = useRef(new KeyedAttempt());
  const held = useRef<{
    body: { expectedVersion: number; previewHash: string };
    key: string;
  } | null>(null);
  const [phase, setPhase] = useState<PublishPhase>("idle");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refusal, setRefusal] = useState<Refused | null>(null);
  const [unclear, setUnclear] = useState<Unclear | null>(null);
  const [notPublished, setNotPublished] = useState(false);
  const [revision, setRevision] = useState(0);
  const wait = useWait(unclear?.retryAfterSec, unclear);

  async function send(body: { expectedVersion: number; previewHash: string }, key: string) {
    setPhase("pending");
    setRefusal(null);
    setNotPublished(false);
    const outcome = await outcomeOf(() => consolePublishCatalogImport(batchId, body, key), {
      resend: true,
    });
    if (outcome.kind === "ok") {
      attempt.current.settle();
      held.current = null;
      setUnclear(null);
      setPhase("idle");
      setDialogOpen(false);
      onPublished(outcome.data.batch, outcome.data.summary, outcome.replayed);
      return;
    }
    if (outcome.kind === "unclear") {
      held.current = { body, key };
      setUnclear(outcome);
      setPhase("unclear");
      return;
    }
    // A terminal answer: the next publish is a new action.
    attempt.current.settle();
    held.current = null;
    setUnclear(null);
    setPhase("idle");
    route(outcome);
  }

  function route(outcome: Refused): void {
    switch (outcome.code) {
      case "stale_validation":
        setDialogOpen(false);
        void reread();
        onRouted({ notice: "stale", step: "validate" });
        return;
      case "preview_changed":
        setDialogOpen(false);
        void reread();
        setRevision((n) => n + 1);
        onRouted({ notice: "previewChanged", step: "preview" });
        return;
      case "import_not_publishable":
        setDialogOpen(false);
        void reread();
        setRevision((n) => n + 1);
        onRouted({ notice: "notPublishable", step: "preview" });
        return;
      case "version_conflict":
        setDialogOpen(false);
        void reread();
        setRevision((n) => n + 1);
        onRouted({ notice: null, step: "preview" });
        return;
      default:
        setRefusal(outcome);
    }
  }

  return {
    phase,
    dialogOpen,
    open: () => {
      setRefusal(null);
      setDialogOpen(true);
    },
    close: () => setDialogOpen(false),
    refusal,
    unclear,
    notPublished,
    wait,
    revision,
    publish: async (preview) => {
      const body = { expectedVersion: preview.version, previewHash: preview.previewHash };
      await send(body, attempt.current.keyFor(JSON.stringify(body)));
    },
    resend: async () => {
      if (held.current) await send(held.current.body, held.current.key);
    },
    refresh: async () => {
      setPhase("refreshing");
      setNotPublished(false);
      const outcome = await outcomeOf(() => consoleGetCatalogImport(batchId));
      if (outcome.kind === "ok" && outcome.data.state === "published") {
        attempt.current.settle();
        held.current = null;
        setUnclear(null);
        setPhase("idle");
        setDialogOpen(false);
        onPublished(outcome.data, null, false);
        return;
      }
      setPhase("unclear");
      if (outcome.kind === "ok") setNotPublished(true);
    },
  };
}
