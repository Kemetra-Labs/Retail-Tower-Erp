import { useLang } from "../i18n/LangContext";
import { ARCH } from "../model/architecture";
import type { Board } from "../model/types";
import { PanelHead, type Freshness } from "./PanelHead";

/**
 * Tasks, changes and CI per station, from Port. A figure Port does not hold is
 * "no data", never 0. (The "not read" wording belongs to the error counts, not
 * to this table.)
 */
export function PerStation({ board, fresh }: { board: Board; fresh?: Freshness }) {
  const { t } = useLang();
  const cell = (v: number | null) =>
    v === null ? (
      <td className="n unk">{t("noData")}</td>
    ) : (
      <td className="n">{v}</td>
    );
  return (
    <section className="card lower-card" aria-labelledby="h-persvc">
      <PanelHead id="h-persvc" title={t("perSvc")} sub={t("perSvcSub")} fresh={fresh} />
      <table className="svc-tbl">
        <thead>
          <tr>
            <th scope="col">{t("thStation")}</th>
            <th scope="col">{t("thTasks")}</th>
            <th scope="col">{t("thPrs")}</th>
            <th scope="col">{t("thRuns")}</th>
            <th scope="col">{t("thFailed")}</th>
          </tr>
        </thead>
        <tbody>
          {board.perStation.map((row) => (
            <tr key={row.station} data-row={row.station}>
              <th scope="row">{ARCH.stations[row.station].name}</th>
              {cell(row.tasks)}
              {cell(row.prs)}
              {cell(row.runs)}
              {cell(row.failed)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
