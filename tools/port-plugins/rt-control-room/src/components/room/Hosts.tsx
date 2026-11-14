import { useLang } from "../../i18n/LangContext";
import { ARCH } from "../../model/architecture";
import type { Alarm, HostView } from "../../model/types";
import { AlarmPin } from "./AlarmPin";
import { SvgText } from "./SvgText";
import { ICONS } from "./icons";
import { hostPins, type HostBox, type RoomLayout } from "./geometry";
import type { Selection } from "./selection";

type Props = {
  hosts: HostView[];
  layout: RoomLayout;
  alarms: Alarm[];
  selection: Selection;
  dimmed: boolean;
  onSelect: (sel: Selection, byKey?: boolean) => void;
};

type HostProps = { view: HostView; box: HostBox; selected: boolean; onSelect: Props["onSelect"] };

function Host({ view, box, selected, onSelect }: HostProps) {
  const { lang, t } = useLang();
  const { ok, total } = view.checks;
  const state = view.up === true ? t("up") : view.up === false ? t("hostDown") : t("hostUnknown");
  // A server that is down or not known is not shown as fine: red for down, amber for unknown.
  const tone = view.up === true ? "ok" : view.up === false ? "bad" : "unk";
  const checks =
    view.unread ? t("notRead") : total === 0 ? t("hostNoChecks") : ok === total ? t("hostChecksOk", { n: ok }) : t("hostChecksSome", { ok, total });
  const sel: Selection = { type: "host", id: view.id };
  return (
    <g
      className="host"
      data-focus={`host:${view.id}`}
      data-checks={`${ok}/${total}`}
      tabIndex={0}
      role="button"
      aria-label={t("hostAria", { name: view.id, state, checks })}
      aria-pressed={selected}
      onClick={() => onSelect(sel, false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(sel, true);
        }
      }}
    >
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={12} />
      <path d={ICONS.hostok} className={`ic ${tone}`} transform={`translate(${box.x + 10} ${box.y + 10}) scale(${16 / 18})`} />
      <SvgText x={box.x + 34} y={box.y + 20} className="hname">
        {`${view.id}  ${state}`}
      </SvgText>
      <SvgText x={box.x + 34} y={box.y + 36} className="hsub">
        {ARCH.hostSub[view.id][lang]}
      </SvgText>
      <SvgText x={box.x + 34} y={box.y + 50} className={`hsub ${total > 0 && ok === total ? "good" : "unk"}`}>
        {checks}
      </SvgText>
    </g>
  );
}

/** The servers under the stations they run, each a focusable button with its Datadog check counts. */
export function Hosts({ hosts, layout, alarms, selection, dimmed, onSelect }: Props) {
  const { t } = useLang();
  return (
    <g className={dimmed ? "dim" : undefined}>
      <SvgText x={30} y={772} className="zone">
        {t("serversLabel")}
      </SvgText>
      {layout.hosts.map((box) => {
        const view = hosts.find((h) => h.id === box.id);
        if (!view) return null;
        const mine = alarms.filter((a) => a.at === box.id);
        const pins = hostPins(box, mine.length);
        return (
          <g key={box.id}>
            <path d={box.linkD} className="cable infra" />
            <Host view={view} box={box} selected={selection?.type === "host" && selection.id === box.id} onSelect={onSelect} />
            {mine.map((alarm, i) => (
              <AlarmPin
                key={alarm.id}
                alarm={alarm}
                x={pins[i].x}
                y={pins[i].y}
                selected={selection?.type === "alarm" && selection.id === alarm.id}
                onSelect={onSelect}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
}
