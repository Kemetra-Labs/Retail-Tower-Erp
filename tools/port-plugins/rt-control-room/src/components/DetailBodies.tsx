import { useLang } from "../i18n/LangContext";
import { ARCH } from "../model/architecture";
import type { Alarm, Board, HostView, Lamp, StationView } from "../model/types";
import { Since, WhereText } from "./AlarmList";
import { KindIcon } from "./KindIcon";
import { KIND_CODE, KIND_TITLE } from "./room/icons";
import { LETTER, ORDER, SOURCE_NAME, STATE_TEXT } from "./room/Lamps";
import type { Selection } from "./room/selection";
import { httpsLink, pathOf, whereOf } from "./where";

type Open = (sel: Selection, byKey?: boolean) => void;

/** Where the fault is on the allowed request path, the failing hop marked (text as well as colour). */
function RequestPath({ alarm }: { alarm: Alarm }) {
  const { t } = useLang();
  const { hops, failing } = pathOf(alarm);
  if (hops.length === 0) return <p className="psub">{t("noPath")}</p>;
  return (
    <ol className="trace" data-path>
      {hops.map((id) => (
        <li key={id} className={id === failing ? "at" : undefined} data-fail={id === failing ? "true" : undefined}>
          {ARCH.stations[id].name}
          {id === failing && <span className="sr"> ({t("hopFailing")})</span>}
        </li>
      ))}
    </ol>
  );
}

/** One alarm: where, kind code, source, since, the path, the message exactly as reported, and a link out. */
export function AlarmBody({ alarm }: { alarm: Alarm }) {
  const { lang, t } = useLang();
  // Port data is not trusted for the scheme: only https is ever a link.
  const link = httpsLink(alarm.link);
  return (
    <>
      <dl className="kv">
        <dt>{t("dWhere")}</dt>
        <dd>
          <WhereText where={whereOf(alarm, lang)} />
        </dd>
        <dt>{t("dKind")}</dt>
        <dd className="measured">{KIND_CODE[alarm.kind]}</dd>
        <dt>{t("dFrom")}</dt>
        <dd>{alarm.source}</dd>
        <dt>{t("dSince")}</dt>
        <dd>
          <Since iso={alarm.since} />
        </dd>
      </dl>
      {alarm.example && <p className="note">{t("exampleTag")}</p>}
      <h3>{t("dPath")}</h3>
      <RequestPath alarm={alarm} />
      <h3>{alarm.source}</h3>
      <div className="msg" dir="ltr">
        {alarm.message}
      </div>
      {alarm.source === "Sentry" && <p className="gapline">{t("gapLine")}</p>}
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer">
          {t(alarm.source === "Sentry" ? "open" : "openDatadog")}
        </a>
      )}
    </>
  );
}

function AlarmButtons({ alarms, onOpen }: { alarms: Alarm[]; onOpen: Open }) {
  const { t } = useLang();
  return (
    <ul className="alarms">
      {alarms.map((a) => (
        <li key={a.id}>
          <button type="button" className="alarm" data-focus={`alarm:${a.id}`} onClick={() => onOpen({ type: "alarm", id: a.id }, true)}>
            <span className="ib">
              <KindIcon kind={a.kind} />
            </span>
            <span>
              <span className="tt">{t(KIND_TITLE[a.kind])}</span>
              <span className="loc measured">{KIND_CODE[a.kind]}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A link in alarm is red, a live one neutral; not linked or no signal yet is unknown (amber); "not needed" is by design. */
function chipTone(lamp: Lamp): string {
  if (lamp.state === "alert") return "bad";
  if (lamp.state === "sending" || lamp.state === "live") return "ok";
  return lamp.state === "na" ? "idle" : "stale";
}

function checksText(view: StationView, t: ReturnType<typeof useLang>["t"]): string {
  const c = view.readings.checks;
  if (c === "na") return t("lampNa");
  if (c === null) return t("noData");
  return c.total === 0 ? t("dChecksNone") : `${c.ok}/${c.total}`;
}

/** A station: the four links, its alarms, health checks and the figures Port holds for it. */
export function StationBody({ view, board, onOpen }: { view: StationView; board: Board; onOpen: Open }) {
  const { lang, t } = useLang();
  const num = (v: number | null, suffix = "") => (v === null ? t("noData") : `${v}${suffix}`);
  const mine = board.alarms.filter((a) => a.station === view.id);
  const alarms = view.readings.alarms;
  if (view.id === "erp") return <p>{t("hostLedgerNote")}</p>;
  return (
    <>
      <p className="psub">{view.role[lang]}</p>
      <h3>{t("ports")}</h3>
      <dl className="kv">
        {ORDER.map((src) => (
          <div className="kvrow" key={src}>
            <dt>{`${LETTER[src]} ${t(SOURCE_NAME[src])}`}</dt>
            <dd>
              <span className={`chip ${chipTone(view.lamps[src])}`}>
                {view.lamps[src].unread ? t("notRead") : t(STATE_TEXT[view.lamps[src].state])}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <h3>{`${t("alarms")}: ${alarms === "not-read" ? t("notRead") : alarms}`}</h3>
      <AlarmButtons alarms={mine} onOpen={onOpen} />
      <dl className="kv">
        <dt>{t("dChecks")}</dt>
        <dd className="measured">{checksText(view, t)}</dd>
        <dt>{t("rdCi")}</dt>
        <dd className="measured">{num(view.readings.ci7d, "%")}</dd>
        <dt>{t("thTasks")}</dt>
        <dd className="measured">{num(view.readings.tasks)}</dd>
        <dt>{t("rdPrs")}</dt>
        <dd className="measured">{num(view.readings.prs)}</dd>
        <dt>{t("rdMerged")}</dt>
        <dd className="measured">{num(view.readings.merged7d)}</dd>
        <dt>{t("rdDeploys")}</dt>
        <dd className="measured">{num(view.readings.deploys)}</dd>
        <dt>{t("rdCiFails")}</dt>
        <dd className="measured">{num(view.readings.ciFails7d)}</dd>
      </dl>
    </>
  );
}

/** A server: what runs on it, whether Datadog says it is up, its checks and the alarms placed on it. */
export function HostBody({ host, board, onOpen }: { host: HostView; board: Board; onOpen: Open }) {
  const { lang, t } = useLang();
  const state = host.up === true ? "up" : host.up === false ? "hostDown" : "hostUnknown";
  const tone = host.up === true ? "ok" : host.up === false ? "bad" : "stale";
  const { ok, total } = host.checks;
  const checks =
    host.unread ? t("notRead") : total === 0 ? t("hostNoChecks") : ok === total ? t("hostChecksOk", { n: ok }) : t("hostChecksSome", { ok, total });
  const pack = board.healthChecks.find((g) => g.key === "servers")?.total ?? 0;
  return (
    <>
      <p className="psub">{ARCH.hostSub[host.id][lang]}</p>
      <dl className="kv">
        <dt>{t("up")}</dt>
        <dd>
          <span className={`chip ${tone}`}>{t(state)}</span>
        </dd>
        <dt>{t("dChecks")}</dt>
        <dd>{checks}</dd>
      </dl>
      {pack > 0 && <p className="psub">{t("hostPackNote", { n: pack })}</p>}
      <AlarmButtons alarms={board.alarms.filter((a) => a.at === host.id)} onOpen={onOpen} />
    </>
  );
}
