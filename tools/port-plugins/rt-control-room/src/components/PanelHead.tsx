import type { ReactNode } from "react";
import { useLang } from "../i18n/LangContext";
import { fmtTime } from "../i18n/strings";

/**
 * Whether the board on screen is the last good snapshot (a poll failed in
 * part) and when that snapshot was read. Every panel shows the same chip, so a
 * stale board never passes for live (spec section 10).
 */
export type Freshness = { stale: boolean; asOf: Date | null };

/** The amber chip of a stale panel: "Stale, last sync 14:30". Nothing when the board is fresh. */
export function StaleChip({ fresh }: { fresh?: Freshness }) {
  const { lang, t } = useLang();
  if (!fresh?.stale) return null;
  const text = fresh.asOf ? t("stateStaleSince", { time: fmtTime(fresh.asOf, lang) }) : t("stateStale");
  return <span className="chip stale">{text}</span>;
}

type Props = {
  id?: string;
  title: ReactNode;
  sub?: ReactNode;
  fresh?: Freshness;
};

/** Title, the stale chip and a one-line subtitle: the head of every lower panel. */
export function PanelHead({ id, title, sub, fresh }: Props) {
  return (
    <div className="phead">
      <div className="phead-row">
        <h2 id={id}>{title}</h2>
        <StaleChip fresh={fresh} />
      </div>
      {sub ? <p className="psub">{sub}</p> : null}
    </div>
  );
}
