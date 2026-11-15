import type { CSSProperties } from "react";
import { useLang } from "../i18n/LangContext";
import type { StringKey } from "../i18n/strings";
import type { Board } from "../model/types";
import { PanelHead, type Freshness } from "./PanelHead";

type Code = Board["ci"]["last72"][number];

const COLOR: Record<Code, string> = {
  s: "var(--color-ok)",
  f: "var(--color-past)",
  c: "var(--color-rule-2)",
  k: "var(--color-cool-soft)",
};
const LEGEND = [
  ["s", "passed"],
  ["f", "failed"],
  ["c", "cancelled"],
  ["k", "skipped"],
] as const satisfies readonly (readonly [Code, StringKey])[];

/**
 * The last finished CI runs as a strip (oldest on the left) and the pass rate.
 * Failures are hatched as well as red. No finished run: "no data", not 0 %.
 */
export function CiStrip({ board, fresh }: { board: Board; fresh?: Freshness }) {
  const { t } = useLang();
  const { last72: runs, passRate } = board.ci;
  const count = (code: Code) => runs.filter((r) => r === code).length;
  return (
    <section className="card lower-card" aria-labelledby="h-ci">
      <PanelHead id="h-ci" title={t("ciTitle")} sub={runs.length > 0 ? t("ciSub", { n: runs.length }) : undefined} fresh={fresh} />
      <div className={`reading measured${passRate === null ? " unk" : ""}`} dir="ltr">
        {passRate === null ? t("noData") : `${passRate}%`}
      </div>
      {passRate !== null && <div className="psub">{t("ciOf", { n: runs.length })}</div>}
      {runs.length > 0 && (
        <>
          <div className="strip-wrap" role="img" aria-label={t("ciAria", { n: runs.length, passed: count("s"), failed: count("f") })}>
            <div className="strip">
              {runs.map((code, i) => (
                <div key={i} className={`cell${code === "f" ? " f" : ""}`} style={{ "--c": COLOR[code] } as CSSProperties} />
              ))}
            </div>
          </div>
          <div className="legend">
            {LEGEND.map(([code, label]) => (
              <span key={code} className={code === "f" ? "f" : undefined} style={{ "--c": COLOR[code] } as CSSProperties}>
                {t(label)} {count(code)}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
