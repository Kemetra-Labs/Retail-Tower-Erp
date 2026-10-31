import { DateTime, formatDateTime, formatDuration, useT } from "@/i18n";
import type { ShiftCloseDetail } from "@/lib/shift-close-queries";
/**
 * RT-1015 (v4.0): the shift's time bar, an Ink band on the close detail. The
 * span runs from `openedAt` to `closedAt` and the white mark is `receivedAt`,
 * all read in the store's zone (UTC, labelled, when it is unknown). The bar is
 * a picture of facts that are also written out beside it, and it names them in
 * one sentence for assistive technology, so colour and position carry nothing
 * alone. With no readable `openedAt` it renders nothing (a fact without a
 * source is omitted); with no usable span it keeps the times and drops the bar.
 *
 * The duration is whole minutes between the two served instants, spoken as
 * hours and minutes. It never touches a cash figure.
 */
import { shiftTimeFacts, splitMinutes } from "./shiftTimes";

interface Props {
  detail: Pick<ShiftCloseDetail, "openedAt" | "closedAt" | "receivedAt">;
  timeZone?: string;
}

function useDurationText(minutes: number | null): string | null {
  const t = useT();
  if (minutes === null) return null;
  const { hours, minutes: rest } = splitMinutes(minutes);
  const h = hours > 0 ? formatDuration(hours * 3600, t.locale) : null;
  const m = rest > 0 ? formatDuration(rest * 60, t.locale) : null;
  if (h && m) return t("shift.timebar.durationJoin", { hours: h, minutes: m });
  return h ?? m;
}

export function ShiftTimeBar({ detail, timeZone }: Readonly<Props>): React.JSX.Element | null {
  const t = useT();
  const facts = shiftTimeFacts(detail);
  const duration = useDurationText(facts?.durationMinutes ?? null);
  if (!facts) return null;
  const at = (iso: string) => formatDateTime(iso, { timeZone, locale: t.locale });
  const { bar } = facts;
  return (
    <div className="shift-timebar">
      {bar ? (
        <div
          className="shift-timebar__track"
          role="img"
          aria-label={t("shift.timebar.label", {
            opened: at(detail.openedAt),
            closed: at(detail.closedAt),
            received: at(detail.receivedAt),
          })}
        >
          <span
            className="shift-timebar__span"
            style={{ insetInlineStart: `${bar.startPct}%`, width: `${bar.endPct - bar.startPct}%` }}
          />
          <span
            className="shift-timebar__mark"
            style={{ insetInlineStart: `${bar.receivedPct}%` }}
          />
        </div>
      ) : null}
      <dl className="shift-timebar__facts">
        <div>
          <dt>{t("shift.field.openedAt")}</dt>
          <dd>
            <DateTime value={detail.openedAt} timeZone={timeZone} />
          </dd>
        </div>
        {duration ? (
          <div>
            <dt>{t("shift.timebar.duration")}</dt>
            <dd>{duration}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("shift.field.closedAt")}</dt>
          <dd>
            <DateTime value={detail.closedAt} timeZone={timeZone} />
          </dd>
        </div>
        <div>
          <dt>{t("shift.field.receivedAt")}</dt>
          <dd>
            <DateTime value={detail.receivedAt} timeZone={timeZone} />
          </dd>
        </div>
      </dl>
      {bar ? <p className="shift-timebar__legend">{t("shift.timebar.legend")}</p> : null}
    </div>
  );
}
