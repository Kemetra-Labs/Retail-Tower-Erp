/**
 * RT-1338 offer editor state: the typed form, the saved draft it is measured against, and the three
 * steps Save → Preview → Publish (spec 048 §10, §18). Holds no business logic: no eligibility, no
 * conflict check, no price arithmetic. Every outcome is Backend-Core's, shown through `noticeOf`.
 *
 *   - Save sends the whole definition (create, or update with `expectedDraftRevision`; a published
 *     offer with no draft starts its next draft with `null`). Shape rules are checked first.
 *   - Preview validates the SAVED draft at one revision, so it is offered only while the form is
 *     clean. Any edit, or a moved revision, drops it: a stale "publishable" never sits beside an
 *     edited form.
 *   - Publish names that revision and is offered only after a publishable preview of it.
 *
 * Typed values outlive every failure, a stale Save included (the page is not reloaded under them). The page keys the editor by offer and draft revision, so a
 * saved, published or reloaded draft remounts it on the server's answer.
 */
import type {
  Offer,
  OfferDefinition,
  OfferPreview,
  OfferSimulationRequest,
} from "@/lib/offer-queries";
import { SAVED_NAVIGATION } from "@/shell/dirty-guard";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  type OfferFormErrors,
  type OfferFormValues,
  buildDefinition,
  emptyOfferForm,
  formOf,
  isDirty,
  validateOfferForm,
} from "./offerFormLogic";
import type { OfferAccess } from "./offerLogic";
import { type OfferNotice, type OfferOutcome, noticeOf } from "./offerOutcomes";
import type { OfferWrites } from "./useOffers";

/** What a new draft starts from: the draft, else the published version, else a blank offer. */
function baselineOf(offer: Offer | undefined, tenantWide: boolean): OfferFormValues {
  const definition: OfferDefinition | undefined =
    offer?.draft?.definition ?? offer?.currentVersion?.definition;
  return definition ? formOf(definition) : emptyOfferForm(tenantWide);
}

/**
 * The banner after a Save. A moved draft keeps what was typed (the page is not reloaded under it, so
 * the copy says to copy it out); a moved state reloads and says so.
 */
function saveNotice(outcome: OfferOutcome<Offer>): OfferNotice {
  const notice = noticeOf(outcome, "offers.save.done");
  const draftMoved = outcome.kind === "stale" && !outcome.stateInvalid;
  return draftMoved ? { ...notice, messageKey: "offers.error.staleSave" } : notice;
}

export type PublishHint = "offers.publish.hintSave" | "offers.publish.hintPreview";

/** Why Publish is not ready yet, for a caller who may publish. */
function publishHintOf(
  canPublish: boolean,
  draftRevision: number | null,
  dirty: boolean,
  hasLivePreview: boolean,
): PublishHint | undefined {
  if (!canPublish) return undefined;
  if (draftRevision === null || dirty) return "offers.publish.hintSave";
  return hasLivePreview ? undefined : "offers.publish.hintPreview";
}

export interface OfferEditorOptions {
  offer: Offer | undefined;
  access: OfferAccess;
  writes: OfferWrites;
  onNotice: (notice: OfferNotice | undefined) => void;
  /** The draft moved under the editor (409): read the offer again. */
  onStale: () => void;
  /** Called when a blocked Save needs the error summary to take focus. */
  focusSummary: () => void;
}

export function useOfferEditor({
  offer,
  access,
  writes,
  onNotice,
  onStale,
  focusSummary,
}: Readonly<OfferEditorOptions>) {
  const navigate = useNavigate();
  const baseline = baselineOf(offer, access.tenantWide);
  const [values, setValues] = useState<OfferFormValues>(baseline);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<"save" | "preview" | "publish" | null>(null);
  const [preview, setPreview] = useState<{ revision: number; data: OfferPreview } | null>(null);

  const dirty = isDirty(baseline, values);
  const draftRevision = offer?.draft?.draftRevision ?? null;
  const errors: OfferFormErrors = validateOfferForm(values, access.tenantWide);
  // The preview counts only for the revision it was made on, and only while nothing is edited.
  const livePreview = preview && !dirty && preview.revision === draftRevision ? preview.data : null;

  function change<K extends keyof OfferFormValues>(field: K, value: OfferFormValues[K]): void {
    setValues((v) => ({ ...v, [field]: value }));
    setPreview(null);
    onNotice(undefined);
  }

  async function save(): Promise<void> {
    if (busy) return;
    setSubmitted(true);
    const built = buildDefinition(values, access.tenantWide);
    if (!built.ok) {
      focusSummary();
      return;
    }
    setBusy("save");
    onNotice(undefined);
    const outcome = offer
      ? await writes.saveDraft(offer.offerId, draftRevision, built.definition)
      : await writes.create(built.definition);
    setBusy(null);
    onNotice(saveNotice(outcome));
    if (outcome.kind === "stale" && outcome.stateInvalid) onStale();
    if (outcome.kind !== "ok") return;
    setPreview(null);
    setSubmitted(false);
    if (!offer) {
      navigate(`/offers/${outcome.data.offerId}`, { replace: true, state: SAVED_NAVIGATION });
    }
  }

  async function runPreview(simulation?: OfferSimulationRequest): Promise<void> {
    if (busy || !offer || draftRevision === null || dirty) return;
    setBusy("preview");
    onNotice(undefined);
    const outcome = await writes.preview(offer.offerId, draftRevision, simulation);
    setBusy(null);
    if (outcome.kind === "ok") {
      setPreview({ revision: draftRevision, data: outcome.data });
      return;
    }
    onNotice(noticeOf(outcome, "offers.preview.done"));
    if (outcome.kind === "stale") onStale();
  }

  async function publish(): Promise<void> {
    if (busy || !offer || draftRevision === null || !livePreview?.publishable) return;
    setBusy("publish");
    onNotice(undefined);
    const outcome = await writes.publish(offer.offerId, draftRevision);
    setBusy(null);
    onNotice(noticeOf(outcome, "offers.publish.done"));
    if (outcome.kind === "stale") onStale();
    if (outcome.kind === "ok") setPreview(null);
  }

  return {
    values,
    change,
    errors,
    shown: submitted ? errors : ({} as OfferFormErrors),
    submitted,
    busy,
    dirty,
    livePreview,
    canPreview: Boolean(offer) && draftRevision !== null && !dirty,
    canPublish: access.canPublish && Boolean(livePreview?.publishable),
    publishHint: publishHintOf(access.canPublish, draftRevision, dirty, livePreview !== null),
    save,
    runPreview,
    publish,
  };
}
