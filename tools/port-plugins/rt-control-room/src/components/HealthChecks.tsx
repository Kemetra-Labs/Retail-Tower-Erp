import { useLang } from "../i18n/LangContext";
import type { StringKey } from "../i18n/strings";
import { HOST_IDS } from "../model/architecture";
import type { Board, HealthGroup } from "../model/types";
import { PanelHead, type Freshness } from "./PanelHead";

const LABEL: Record<HealthGroup["key"], StringKey> = {
  core: "hcCore",
  servers: "hcServers",
  databases: "hcDatabases",
  admin: "hcAdmin",
  conn: "hcConn",
  pos: "hcPos",
  other: "hcOther",
};

/** red for a check in alarm, neutral when every check is OK, amber when a group has none or only some answer. */
function toneOf(g: HealthGroup): "bad" | "ok" | "stale" | "idle" {
  if (g.na) return "idle";
  if (g.alert) return "bad";
  if (g.total === 0) return "stale";
  return g.ok === g.total ? "ok" : "stale";
}

/** Datadog checks grouped by what they watch. A group with no check is unknown (amber), never healthy. */
export function HealthChecks({ board, fresh }: { board: Board; fresh?: Freshness }) {
  const { t } = useLang();
  const total = board.healthChecks.reduce((n, g) => n + g.total, 0);
  return (
    <section className="card lower-card" aria-labelledby="h-health">
      <PanelHead id="h-health" title={t("hostsTitle")} sub={t("hostsSub", { n: total })} fresh={fresh} />
      <div className="hosts">
        {board.healthChecks.map((g) => (
          <div className="hrow" key={g.key} data-group={g.key}>
            <span>{t(LABEL[g.key], { n: HOST_IDS.length })}</span>
            <span className={`chip ${toneOf(g)} measured`}>
              {g.na ? t("lampNa") : g.unread ? t("notRead") : g.total === 0 ? t("none") : `${g.ok}/${g.total}`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
