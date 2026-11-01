/**
 * RT-474 editor state: choose a file → server preview → save, plus remove.
 *
 * - The latest file wins: a new choice aborts the running preview, and a late
 *   answer for an older file is ignored.
 * - Save sends the exact File that produced the preview, that preview's
 *   `version` as `preview_version`, and the `revision` the page holds as
 *   `expected_revision`. Each write's returned branding replaces the cached one,
 *   so the next write chains the server's new revision. A 409
 *   `logo_changed_concurrently` never refreshes the revision silently.
 * - A 429 records its Retry-After on the shared clock (src/lib/rate-limit.ts);
 *   writes are never retried automatically. A preview stopped by a 429 keeps its
 *   file and offers a gated re-run.
 * - `formKey` remounts the hidden file form after a refusal, a cancel, a save or
 *   a removal: the unsaved-work guard (RT-268) drops a form that left the page,
 *   and the same file can be chosen again.
 * - A choice or a cancel while a save is in flight wins: the late save answer
 *   does not bring back the old flow (its stored branding is still kept, since
 *   the server did write it).
 * - `onFocus` tells the page where focus goes when the focused control leaves:
 *   the file control after a choice, the entry control after a cancel, the
 *   remove button when a conflict closes the remove confirm.
 */
import type { MessageKey } from "@/i18n";
import {
  type LogoPreview,
  type TenantBranding,
  consoleDeleteTenantLogo,
  consolePreviewTenantLogo,
  consolePutTenantLogo,
} from "@/lib/tenant-branding-queries";
import { useEffect, useRef, useState } from "react";
import { type BrandingOutcome, classifyBrandingWrite, precheckLogoFile } from "./brandingLogic";

export type EditorPhase =
  | { kind: "idle" }
  | { kind: "previewing"; file: File }
  | { kind: "preview"; file: File; preview: LogoPreview }
  | { kind: "refused"; file: File; messageKey: MessageKey }
  /** The preview stopped on a 429 or a failure; the file is kept for a re-run. */
  | { kind: "retry"; file: File };

export type EditorFocus = "control" | "entry" | "remove";

export type EditorNotice =
  | { kind: "saved" }
  | { kind: "removed" }
  | { kind: "conflict" }
  | { kind: "session" }
  | { kind: "failed"; requestId?: string };

export interface LogoEditor {
  phase: EditorPhase;
  notice: EditorNotice | null;
  noAccess: boolean;
  busy: "save" | "remove" | null;
  confirmingRemove: boolean;
  formKey: number;
  choose: (file: File) => void;
  rerunPreview: () => void;
  save: () => Promise<void>;
  remove: () => Promise<void>;
  cancel: () => void;
  askRemove: (open: boolean) => void;
  clearConflict: () => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function settle<T>(
  call: () => Promise<{ status: number; data?: T; error?: unknown }>,
): Promise<BrandingOutcome<T>> {
  try {
    return classifyBrandingWrite(await call());
  } catch (error) {
    if (isAbort(error)) throw error;
    return { kind: "failed", status: 0 };
  }
}

export function useLogoEditor(
  tenantId: string,
  revision: number,
  storeBranding: (b: TenantBranding) => void,
  onFocus: (target: EditorFocus) => void,
): LogoEditor {
  const [phase, setPhase] = useState<EditorPhase>({ kind: "idle" });
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [noAccess, setNoAccess] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const running = useRef<AbortController | null>(null);
  // Bumped by every choice and cancel, so a late save answer can tell it is stale.
  const generation = useRef(0);

  useEffect(() => () => running.current?.abort(), []);

  const resetForm = () => setFormKey((k) => k + 1);

  /** The outcomes every operation handles the same way. Returns true when handled. */
  const common = (outcome: BrandingOutcome<unknown>): boolean => {
    if (outcome.kind === "noAccess") setNoAccess(true);
    else if (outcome.kind === "session") setNotice({ kind: "session" });
    else if (outcome.kind === "conflict") setNotice({ kind: "conflict" });
    else if (outcome.kind === "failed") setNotice({ kind: "failed", requestId: outcome.requestId });
    else return outcome.kind === "rateLimited";
    return true;
  };

  const runPreview = async (file: File) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setPhase({ kind: "previewing", file });
    let outcome: BrandingOutcome<LogoPreview>;
    try {
      outcome = await settle(() => consolePreviewTenantLogo(tenantId, file, controller.signal));
    } catch {
      return; // aborted: a newer file took over
    }
    if (running.current !== controller) return;
    running.current = null;
    if (outcome.kind === "ok") setPhase({ kind: "preview", file, preview: outcome.data });
    else if (outcome.kind === "refused") {
      setPhase({ kind: "refused", file, messageKey: outcome.messageKey });
      resetForm();
    } else {
      common(outcome);
      setPhase({ kind: "retry", file });
    }
  };

  const choose = (file: File) => {
    generation.current += 1;
    onFocus("control");
    setNotice((n) => (n?.kind === "conflict" ? n : null));
    setConfirmingRemove(false);
    const local = precheckLogoFile(file);
    if (local) {
      running.current?.abort();
      running.current = null;
      setPhase({ kind: "refused", file, messageKey: local });
      resetForm();
      return;
    }
    void runPreview(file);
  };

  const rerunPreview = () => {
    if (phase.kind === "retry") void runPreview(phase.file);
  };

  const save = async () => {
    if (phase.kind !== "preview" || busy) return;
    const { file, preview } = phase;
    const started = generation.current;
    setBusy("save");
    setNotice(null);
    const outcome = await settle(() =>
      consolePutTenantLogo(tenantId, file, {
        previewVersion: preview.version,
        expectedRevision: revision,
      }),
    );
    setBusy(null);
    if (started !== generation.current) {
      if (outcome.kind === "ok") storeBranding(outcome.data);
      return;
    }
    if (outcome.kind === "ok") {
      storeBranding(outcome.data);
      setPhase({ kind: "idle" });
      setNotice({ kind: "saved" });
      resetForm();
    } else if (outcome.kind === "refused") {
      setPhase({ kind: "refused", file, messageKey: outcome.messageKey });
      resetForm();
    } else common(outcome);
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove");
    setNotice(null);
    const outcome = await settle(() =>
      consoleDeleteTenantLogo(tenantId, { expectedRevision: revision }),
    );
    setBusy(null);
    if (outcome.kind === "ok") {
      storeBranding(outcome.data);
      setConfirmingRemove(false);
      setPhase({ kind: "idle" });
      setNotice({ kind: "removed" });
      resetForm();
      return;
    }
    if (outcome.kind === "conflict") {
      setConfirmingRemove(false);
      onFocus("remove");
    }
    common(outcome);
  };

  const cancel = () => {
    generation.current += 1;
    onFocus("entry");
    running.current?.abort();
    running.current = null;
    setPhase({ kind: "idle" });
    setNotice((n) => (n?.kind === "conflict" ? n : null));
    resetForm();
  };

  return {
    phase,
    notice,
    noAccess,
    busy,
    confirmingRemove,
    formKey,
    choose,
    rerunPreview,
    save,
    remove,
    cancel,
    askRemove: setConfirmingRemove,
    clearConflict: () => setNotice(null),
  };
}
