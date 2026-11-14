import { useLang } from "../../i18n/LangContext";
import type { StringKey } from "../../i18n/strings";
import { ICONS, KIND_CODE, LEGEND_KINDS } from "./icons";

const SWATCHES: { key: StringKey; color: string; dash: boolean }[] = [
  { key: "lgLive", color: "var(--color-cool)", dash: false },
  { key: "lgFault", color: "var(--color-bad)", dash: true },
  { key: "lgUnwatched", color: "var(--color-stale)", dash: true },
  { key: "lgInfra", color: "var(--color-rule-2)", dash: true },
  { key: "lgRule", color: "var(--color-muted)", dash: true },
];
const LETTERS: [string, StringKey][] = [
  ["ERR", "srcSentry"],
  ["HLT", "srcDatadog"],
  ["GIT", "srcGithub"],
  ["JIR", "srcJira"],
];

/** Cable types, lamp letters, the alarm icon set and the caption that motion means "the link is up". */
export function Legend() {
  const { t } = useLang();
  return (
    <div className="legend-block">
      <div className="legend-row">
        {SWATCHES.map((s) => (
          <span className="it" key={s.key}>
            <span className={`swatch${s.dash ? " dash" : ""}`} style={{ borderTopColor: s.color }} />
            {t(s.key)}
          </span>
        ))}
      </div>
      <div className="legend-row">
        {LETTERS.map(([letter, key]) => (
          <span key={letter}>{`${letter} = ${t(key)}`}</span>
        ))}
        <span className="sep" />
        <span>{`${t("lgIcons")}:`}</span>
        {LEGEND_KINDS.map((kind) => (
          <span className="it" key={kind}>
            <svg viewBox="0 0 18 18" width={18} height={18} aria-hidden="true">
              <path d={ICONS[kind]} className={kind === "unknown" ? "ic unk" : "ic"} />
            </svg>
            {KIND_CODE[kind]}
          </span>
        ))}
      </div>
      <p className="legend-cap">{t("lgFlow")}</p>
    </div>
  );
}
