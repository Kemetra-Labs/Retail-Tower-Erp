/**
 * RT-1338 pause drawer (spec 048 §10, OD-12): an emergency stop with a REQUIRED reason (1 to 500
 * characters, no personal data: the reason is audited). The caller names what to pause:
 *
 *   - owner or tenant_admin with tenant-wide stores: the whole offer, or chosen stores;
 *   - a store_manager (or anyone bounded to specific stores): chosen stores of their OWN roster,
 *     never the whole offer. The server answers a whole-offer pause by such a caller with a 403.
 *
 * Pausing never deletes history (§21). A pause is replayable under one Idempotency-Key, held by
 * `useOfferWrites` through an unclear answer. The server's words never show; the request id does.
 */
import { Banner } from "@/components/Banner";
import { FormDrawer } from "@/components/FormDrawer";
import { FormField } from "@/components/FormField";
import { FormSection } from "@/components/FormPage";
import { InlineError } from "@/components/InlineError";
import { useT } from "@/i18n";
import type { Offer } from "@/lib/offer-queries";
import { useState } from "react";
import {
  type OfferAccess,
  type PauseErrors,
  type PauseScope,
  REASON_MAX,
  buildPauseBody,
  pausableStores,
} from "./offerLogic";
import { type OfferNotice, type OfferOutcome, noticeOf } from "./offerOutcomes";

type Store = { id: string; name?: string };

export interface OfferPauseDrawerProps {
  offer: Offer;
  access: OfferAccess;
  roster: readonly Store[];
  onPause: (body: { reason: string; storeIds?: string[] }) => Promise<OfferOutcome<Offer>>;
  onDone: (notice: OfferNotice) => void;
  onClose: () => void;
}

export function OfferPauseDrawer({
  offer,
  access,
  roster,
  onPause,
  onDone,
  onClose,
}: Readonly<OfferPauseDrawerProps>): React.JSX.Element {
  const t = useT();
  const stores = pausableStores(offer, roster);
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<PauseScope>(access.canPauseWhole ? "whole" : "stores");
  const [chosen, setChosen] = useState<string[]>([]);
  const [errors, setErrors] = useState<PauseErrors>({});
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<OfferNotice | undefined>();
  // A whole-offer pause that is already in force leaves only store pauses to add.
  const wholeAvailable = access.canPauseWhole && offer.state !== "paused";

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setNotice(undefined);
    const built = buildPauseBody(
      { reason, scope: wholeAvailable ? scope : "stores", storeIds: chosen },
      { ...access, canPauseWhole: wholeAvailable },
    );
    if (!built.ok) {
      setErrors(built.errors);
      return; // nothing is sent
    }
    setErrors({});
    setPending(true);
    const outcome = await onPause(built.body);
    setPending(false);
    if (outcome.kind === "ok") onDone(noticeOf(outcome, "offers.pause.done"));
    else setNotice(noticeOf(outcome, "offers.pause.done"));
  }

  return (
    <FormDrawer
      title={t("offers.pause.title")}
      onClose={onClose}
      dismissible={!pending}
      onSubmit={(e) => void submit(e)}
      submitLabel={t("offers.pause.confirm")}
      submitClass="btn-destructive"
      pending={pending}
      note={<Banner variant="info" message={t("offers.pause.note")} />}
      notice={notice}
    >
      <FormSection>
        <FormField
          id="pause-reason"
          label={t("offers.pause.reason")}
          hint={t("offers.pause.reasonHint", { max: REASON_MAX })}
          required
          announceError
          error={errors.reason ? t(errors.reason) : undefined}
        >
          {(aria) => (
            <textarea
              id="pause-reason"
              className="input"
              dir="auto"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              {...aria}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection title={t("offers.pause.scope")}>
        {wholeAvailable ? (
          <label className="offer-rule__choice">
            <input
              type="radio"
              name="pause-scope"
              checked={scope === "whole"}
              onChange={() => setScope("whole")}
            />
            {t("offers.pause.scopeWhole")}
          </label>
        ) : null}
        <label className="offer-rule__choice">
          <input
            type="radio"
            name="pause-scope"
            checked={scope === "stores" || !wholeAvailable}
            onChange={() => setScope("stores")}
          />
          {t(access.canPauseWhole ? "offers.pause.scopeStores" : "offers.pause.scopeOwnStores")}
        </label>
        {scope === "stores" || !wholeAvailable ? (
          <>
            {stores.length === 0 ? (
              <p className="content__sub">{t("offers.pause.noStores")}</p>
            ) : null}
            <ul className="offer-rule__choices">
              {stores.map((store) => (
                <li key={store.id}>
                  <label className="offer-rule__choice">
                    <input
                      type="checkbox"
                      name="pauseStoreIds"
                      value={store.id}
                      checked={chosen.includes(store.id)}
                      onChange={() =>
                        setChosen((prev) =>
                          prev.includes(store.id)
                            ? prev.filter((s) => s !== store.id)
                            : [...prev, store.id],
                        )
                      }
                    />
                    <bdi dir="auto">{store.name ?? store.id}</bdi>
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <InlineError message={errors.storeIds ? t(errors.storeIds) : undefined} />
      </FormSection>
    </FormDrawer>
  );
}
