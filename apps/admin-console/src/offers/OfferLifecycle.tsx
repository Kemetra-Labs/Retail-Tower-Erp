/**
 * RT-1338 lifecycle controls of a saved offer: Pause, Resume, End, Archive. Friction follows
 * consequence (UX-05.2): a pause opens its drawer (the reason is required); End and Archive are a
 * quiet start and an explicit confirm naming the consequence, with the safe choice beside it;
 * Resume re-checks conflicts on the server and says so.
 *
 * Which controls show is `offerActions` (a mirror of the roles and the state); Backend-Core
 * re-checks every one and its refusal is shown as a banner. A store_manager is offered Pause only.
 */
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import type { Offer } from "@/lib/offer-queries";
import { useState } from "react";
import { OfferPauseDrawer } from "./OfferPauseDrawer";
import { type OfferAccess, offerActions } from "./offerLogic";
import { type OfferNotice, type OfferOutcome, noticeOf } from "./offerOutcomes";
import type { OfferWrites } from "./useOffers";

type Store = { id: string; name?: string };
type Confirming = "resume" | "end" | "archive";

const CONFIRM_COPY: Record<Confirming, { prompt: MessageKey; ok: MessageKey; done: MessageKey }> = {
  resume: {
    prompt: "offers.resume.prompt",
    ok: "offers.resume.confirm",
    done: "offers.resume.done",
  },
  end: { prompt: "offers.end.prompt", ok: "offers.end.confirm", done: "offers.end.done" },
  archive: {
    prompt: "offers.archive.prompt",
    ok: "offers.archive.confirm",
    done: "offers.archive.done",
  },
};

export interface OfferLifecycleProps {
  offer: Offer;
  access: OfferAccess;
  roster: readonly Store[];
  writes: OfferWrites;
  onNotice: (notice: OfferNotice) => void;
}

export function OfferLifecycle({
  offer,
  access,
  roster,
  writes,
  onNotice,
}: Readonly<OfferLifecycleProps>): React.JSX.Element | null {
  const t = useT();
  const actions = offerActions(offer, access);
  const [pausing, setPausing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [pending, setPending] = useState(false);

  if (!(actions.pause || actions.resume || actions.end || actions.archive)) return null;

  async function confirm(): Promise<void> {
    if (!confirming || pending) return;
    setPending(true);
    let outcome: OfferOutcome<Offer>;
    if (confirming === "resume") outcome = await writes.resume(offer.offerId, {});
    else if (confirming === "end") outcome = await writes.end(offer.offerId);
    else outcome = await writes.archive(offer.offerId);
    setPending(false);
    onNotice(noticeOf(outcome, CONFIRM_COPY[confirming].done));
    // A terminal answer closes the confirm; an unclear one keeps it so the same key can retry.
    if (outcome.kind !== "failed" || !outcome.keepKey) setConfirming(null);
  }

  return (
    <section className="offer-lifecycle" aria-label={t("offers.lifecycle.title")}>
      <h3 className="offer-rule__legend">{t("offers.lifecycle.title")}</h3>
      {confirming ? (
        <div className="offer-lifecycle__confirm">
          <Banner variant="warning" message={t(CONFIRM_COPY[confirming].prompt)} />
          <div className="offer-preview__actions">
            <GatedButton
              type="button"
              className={confirming === "resume" ? "btn-primary" : "btn-destructive"}
              busy={pending}
              onClick={() => void confirm()}
            >
              {t(CONFIRM_COPY[confirming].ok)}
            </GatedButton>
            <button
              type="button"
              className="btn-ghost"
              disabled={pending}
              onClick={() => setConfirming(null)}
            >
              {t("offers.lifecycle.keep")}
            </button>
          </div>
        </div>
      ) : (
        <div className="offer-preview__actions">
          {actions.pause ? (
            <button type="button" className="btn-secondary" onClick={() => setPausing(true)}>
              {t("offers.pause.open")}
            </button>
          ) : null}
          {actions.resume ? (
            <button type="button" className="btn-secondary" onClick={() => setConfirming("resume")}>
              {t("offers.resume.open")}
            </button>
          ) : null}
          {actions.end ? (
            <button type="button" className="btn-danger-quiet" onClick={() => setConfirming("end")}>
              {t("offers.end.open")}
            </button>
          ) : null}
          {actions.archive ? (
            <button
              type="button"
              className="btn-danger-quiet"
              onClick={() => setConfirming("archive")}
            >
              {t("offers.archive.open")}
            </button>
          ) : null}
        </div>
      )}
      {pausing ? (
        <OfferPauseDrawer
          offer={offer}
          access={access}
          roster={roster}
          onPause={(body) => writes.pause(offer.offerId, body)}
          onDone={(notice) => {
            setPausing(false);
            onNotice(notice);
          }}
          onClose={() => setPausing(false)}
        />
      ) : null}
    </section>
  );
}
