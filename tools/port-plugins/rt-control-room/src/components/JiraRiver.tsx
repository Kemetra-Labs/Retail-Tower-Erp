import type { CSSProperties } from "react";
import { useLang } from "../i18n/LangContext";
import type { StringKey } from "../i18n/strings";
import type { Board } from "../model/types";
import { PanelHead, type Freshness } from "./PanelHead";

const COLUMNS = [
  ["todo", "jiraTodo", "var(--color-muted)"],
  ["inProgress", "jiraProgress", "var(--color-cool)"],
  ["review", "jiraReview", "var(--color-ink-2)"],
  ["done", "jiraDone", "var(--color-ok)"],
] as const satisfies readonly (readonly [keyof Board["jira"], StringKey, string])[];

/** RT tasks by status. With no task read at all the columns say "no data" instead of four zeros. */
export function JiraRiver({ board, fresh }: { board: Board; fresh?: Freshness }) {
  const { t } = useLang();
  const total = COLUMNS.reduce((n, [key]) => n + board.jira[key], 0);
  return (
    <section className="card lower-card" aria-labelledby="h-jira">
      <PanelHead id="h-jira" title={t("jiraTitle")} sub={total > 0 ? t("jiraSub", { n: total }) : undefined} fresh={fresh} />
      <div className="river">
        {COLUMNS.map(([key, label, color]) => (
          <div className="col" key={key} data-status={key} style={{ "--c": color } as CSSProperties}>
            <div className={`n measured${total === 0 ? " unk" : ""}`}>{total === 0 ? t("noData") : board.jira[key]}</div>
            <div className="l">{t(label)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
