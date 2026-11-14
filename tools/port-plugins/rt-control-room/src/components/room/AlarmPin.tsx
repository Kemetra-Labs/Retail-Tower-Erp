import { useLang } from "../../i18n/LangContext";
import type { Alarm } from "../../model/types";
import { alarmTitle } from "../where";
import { ICONS, KIND_CODE } from "./icons";
import type { Selection } from "./selection";

type Props = {
  alarm: Alarm;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (sel: Selection, byKey?: boolean) => void;
};

/** An alarm pinned where it happens: a focusable button on the map (Enter or click opens the detail). */
export function AlarmPin({ alarm, x, y, selected, onSelect }: Props) {
  const { lang } = useLang();
  const kind = alarm.kind;
  const label = `${alarmTitle(alarm, lang)}, ${KIND_CODE[kind]}`;
  const sel: Selection = { type: "alarm", id: alarm.id };
  return (
    <g
      className={`pin${selected ? " on" : ""}`}
      data-focus={`pin:${alarm.id}`}
      data-at={alarm.at}
      data-kind={kind}
      tabIndex={0}
      role="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(sel, false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(sel, true);
        }
      }}
    >
      <rect x={x} y={y} width={20} height={20} rx={4} className="box" filter="url(#rt-glow)" />
      <path d={ICONS[kind]} className="ic" transform={`translate(${x + 3} ${y + 3}) scale(${14 / 18})`} />
      <title>{`${alarmTitle(alarm, lang)} (${KIND_CODE[kind]})`}</title>
    </g>
  );
}
