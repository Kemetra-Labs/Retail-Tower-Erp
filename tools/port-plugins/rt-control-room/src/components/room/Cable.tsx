import type { Ref } from "react";
import { useLang } from "../../i18n/LangContext";
import type { CableView } from "../../model/types";
import { SvgText } from "./SvgText";
import type { CableGeom } from "./geometry";

type Props = {
  cable: CableView;
  geom: CableGeom;
  /** The Sentry read failed: a cable with no cached fault is "not read", never "no faults". */
  notRead: boolean;
  dim: boolean;
  slow: boolean;
  wrapRef: Ref<SVGGElement>;
  gateRef: Ref<SVGGElement>;
};

/**
 * One cable: its path, the moving "link is up" dots, a gate for the refused
 * gesture and its tag. A cable nothing watches (no fault could be placed on it)
 * is static, dashed and amber and reads "Not watched", never "no faults".
 */
export function Cable({ cable, geom, notRead, dim, slow, wrapRef, gateRef }: Props) {
  const { lang, t } = useLang();
  const carries = cable.carries[lang];
  const unwatched = !cable.watched && cable.faults === 0;
  const unread = !unwatched && notRead && cable.faults === 0;
  const state = unwatched
    ? t("cableNotWatched")
    : unread
      ? t("notRead")
      : cable.faults === 0
        ? t("cableNoFaults")
        : cable.faults === 1
          ? t("cableFaultsOne")
          : t("cableFaults", { n: cable.faults });
  const w = Math.max(carries.length, state.length) * 7.4 + 16;
  const tone = unwatched || unread ? "var(--color-stale)" : cable.faults > 0 ? "var(--color-bad)" : "var(--color-muted)";
  const look = unwatched ? "unwatched" : cable.state;
  return (
    <g data-cable-wrap={cable.id} ref={wrapRef}>
      <path d={geom.d} className={`cable ${look}${dim ? " dim" : ""}`} data-cable={cable.id} />
      {!unwatched && (
        <path
          d={geom.d}
          filter="url(#rt-glow)"
          className={`current ${cable.state === "fault" ? "stall" : "live"}${slow ? " slow" : ""}${dim ? " dim" : ""}`}
        />
      )}
      <g data-gate={cable.id} ref={gateRef} className="gate">
        <line x1={geom.gate.x} y1={geom.gate.y1} x2={geom.gate.x} y2={geom.gate.y2} />
      </g>
      <g className={dim ? "dim" : undefined} data-cable-tag={cable.id}>
        <rect x={geom.label.x - w / 2} y={geom.label.y - 14} width={w} height={34} rx={4} className="clabel-bg" />
        <SvgText x={geom.label.x} y={geom.label.y} className="clabel" anchor="middle">
          {carries}
        </SvgText>
        <SvgText x={geom.label.x} y={geom.label.y + 15} className="cstate" anchor="middle" fill={tone} data-state={unwatched ? "not-watched" : unread ? "not-read" : "read"}>
          {state}
        </SvgText>
      </g>
    </g>
  );
}
