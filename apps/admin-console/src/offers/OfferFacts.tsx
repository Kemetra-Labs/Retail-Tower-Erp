/**
 * RT-1338 read-only facts of a saved offer: its derived state, the published version a till
 * applies, the whole-offer pause and the store pauses (with their reasons), catalog changes that
 * took products out of its eligible set (re-materialisation conflicts), and its immutable versions.
 *
 * A store_manager's read is filtered by the server to their own stores: `pausedStores` and the
 * stores of the scope are then THEIR stores only, never the complete lists. The copy says so,
 * and nothing here totals or compares them. An all-stores offer reads `allStores: true`.
 */
import { LedgerField } from "@/components/DetailPanel";
import { useT } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import type { Offer, OfferVersion } from "@/lib/offer-queries";
import { OfferStateBadge, ScheduleText, ScopeText } from "./OfferParts";
import type { OfferAccess, OfferActions } from "./offerLogic";

type Store = { id: string; name?: string };

function Rematerialisation({ offer }: Readonly<{ offer: Offer }>): React.JSX.Element | null {
  const t = useT();
  if (offer.rematerialisationConflicts.length === 0) return null;
  return (
    <section className="offer-preview__block" aria-label={t("offers.facts.removed")}>
      <h4 className="offer-rule__legend">{t("offers.facts.removed")}</h4>
      <p className="field__hint">{t("offers.facts.removedHint")}</p>
      <ul className="offer-preview__list">
        {offer.rematerialisationConflicts.map((c) => (
          <li key={`${c.offerId}-${c.offerVersion}`}>
            <bdi dir="auto">{c.nameAr}</bdi> ·{" "}
            {t("offers.preview.sharedProducts", { count: c.removedProductCount })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Pauses({
  offer,
  roster,
  canResume,
  onResumeStore,
}: Readonly<{
  offer: Offer;
  roster: readonly Store[];
  canResume: boolean;
  onResumeStore: (storeId: string) => void;
}>): React.JSX.Element | null {
  const t = useT();
  if (!offer.pause && offer.pausedStores.length === 0) return null;
  const nameOf = (id: string) => roster.find((s) => s.id === id)?.name ?? id;
  return (
    <section className="offer-preview__block" aria-label={t("offers.facts.pauses")}>
      <h4 className="offer-rule__legend">{t("offers.facts.pauses")}</h4>
      {offer.pause ? (
        <p>
          <strong>{t("offers.facts.wholePause")}</strong> · {formatDateTime(offer.pause.pausedAt)}
          {" · "}
          <bdi dir="auto">{offer.pause.reason}</bdi>
        </p>
      ) : null}
      {offer.pausedStores.length > 0 ? (
        <ul className="offer-preview__list">
          {offer.pausedStores.map((p) => (
            <li key={p.storeId}>
              <bdi dir="auto">{nameOf(p.storeId)}</bdi> · {formatDateTime(p.pausedAt)} ·{" "}
              <bdi dir="auto">{p.reason}</bdi>
              {canResume ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onResumeStore(p.storeId)}
                    aria-label={t("offers.facts.resumeStoreLabel", { name: nameOf(p.storeId) })}
                  >
                    {t("offers.facts.resumeStore")}
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Versions({
  versions,
  current,
}: Readonly<{ versions: readonly OfferVersion[]; current: number | null }>) {
  const t = useT();
  if (versions.length === 0) return null;
  return (
    <section className="offer-preview__block" aria-label={t("offers.facts.versions")}>
      <h4 className="offer-rule__legend">{t("offers.facts.versions")}</h4>
      <ul className="offer-preview__list">
        {versions.map((v) => (
          <li key={v.version}>
            {t("offers.facts.version", { version: v.version })} · {formatDateTime(v.publishedAt)} ·{" "}
            {t("offers.preview.eligibleCount", { count: v.eligibleSetCount })}
            {v.version === current ? ` · ${t("offers.facts.currentVersion")}` : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface OfferFactsProps {
  offer: Offer;
  roster: readonly Store[];
  access: OfferAccess;
  actions: OfferActions;
  versions: readonly OfferVersion[];
  storeScoped: boolean;
  onResumeStore: (storeId: string) => void;
}

export function OfferFacts({
  offer,
  roster,
  access,
  actions,
  versions,
  storeScoped,
  onResumeStore,
}: Readonly<OfferFactsProps>): React.JSX.Element {
  const t = useT();
  const current = offer.currentVersion;
  return (
    <div className="offer-facts">
      <dl className="surface__detail">
        <LedgerField label={t("offers.facts.state")}>
          <OfferStateBadge state={offer.state} />
        </LedgerField>
        <LedgerField label={t("offers.facts.published")}>
          {current ? (
            <>
              {t("offers.facts.version", { version: current.version })} ·{" "}
              {formatDateTime(current.publishedAt)} ·{" "}
              {t("offers.preview.eligibleCount", { count: current.eligibleSetCount })}
            </>
          ) : (
            t("offers.facts.neverPublished")
          )}
        </LedgerField>
        {current ? (
          <>
            <LedgerField label={t("offers.facts.schedule")}>
              <ScheduleText schedule={current.definition.schedule} />
            </LedgerField>
            <LedgerField label={t("offers.facts.stores")}>
              <ScopeText scope={current.definition.storeScope} roster={roster} />
            </LedgerField>
          </>
        ) : null}
        <LedgerField label={t("offers.facts.draft")}>
          {offer.draft
            ? t("offers.facts.draftRevision", { revision: offer.draft.draftRevision })
            : t("offers.facts.noDraft")}
        </LedgerField>
        {offer.endedAt ? (
          <LedgerField label={t("offers.facts.endedAt")}>
            {formatDateTime(offer.endedAt)}
          </LedgerField>
        ) : null}
        {offer.archivedAt ? (
          <LedgerField label={t("offers.facts.archivedAt")}>
            {formatDateTime(offer.archivedAt)}
          </LedgerField>
        ) : null}
      </dl>
      {storeScoped ? <p className="field__hint">{t("offers.facts.ownStoresNote")}</p> : null}
      <Pauses
        offer={offer}
        roster={roster}
        canResume={actions.resume && access.canPublish}
        onResumeStore={onResumeStore}
      />
      <Rematerialisation offer={offer} />
      <Versions versions={versions} current={current?.version ?? null} />
    </div>
  );
}
