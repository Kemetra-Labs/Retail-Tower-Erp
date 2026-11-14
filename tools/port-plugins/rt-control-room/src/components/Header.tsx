import { useEffect, useState, type ReactNode } from "react";
import { useLang } from "../i18n/LangContext";
import { agoText, fmtTime, type StringKey } from "../i18n/strings";
import type { Board } from "../model/types";
import type { BoardStatus } from "../state/useBoard";

export type HeaderProps = {
  /** Null until the first read completes: the header then shows no figure. */
  board: Board | null;
  status: BoardStatus;
  /** True while the labelled 24 h replay runs. */
  replaying: boolean;
  /** The last fully good sync (a poll that read everything), or null when there has been none. */
  asOf: Date | null;
  /** When the newest lab deployment changed, or null when Port has none. */
  labUpdatedAt: string | null;
  /** The Pause motion flag, owned by the host (see `usePaused`). */
  paused: boolean;
  onTogglePause: () => void;
  /** Extra controls (the Ops | Story switch, the example button), placed before the language button. */
  controls?: ReactNode;
};

type Theme = "dark" | "light";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Light or dark palette: flips `data-theme` on <html> (dark is the default). */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

/** The alarm count chip. A failed error read never reads as "0 alarms". */
function AlarmChip({ board }: { board: Board }) {
  const { t } = useLang();
  const n = board.alarms.length;
  const notRead = board.stations.some((s) => s.readings.alarms === "not-read");
  if (n === 0 && notRead) return <span className="chip stale">{t("errorsNotRead")}</span>;

  const examples = board.alarms.filter((a) => a.example).length;
  const suffix = examples === 0 ? "" : ` ${t(examples === 1 ? "exampleOne" : "exampleTwo")}`;
  const count = n === 0 ? t("alarmsNone") : n === 1 ? t("alarmsActiveOne") : t("alarmsActive", { n });
  return <span className={`chip ${n > 0 ? "bad" : "ok"}`}>{count + suffix}</span>;
}

/** Amber for a stale or unreadable board; stale carries the time of the last good sync. */
function StatusChip({ status, asOf }: { status: BoardStatus; asOf: Date | null }) {
  const { lang, t } = useLang();
  if (status === "stale") {
    const text = asOf ? t("stateStaleSince", { time: fmtTime(asOf, lang) }) : t("stateStale");
    return <span className="chip stale">{text}</span>;
  }
  if (status === "error") return <span className="chip stale">{t("stateError")}</span>;
  return null;
}

export function Header(props: HeaderProps) {
  const { board, status, replaying, asOf, labUpdatedAt, paused, onTogglePause, controls } = props;
  const { lang, t, setLang } = useLang();
  const [theme, toggleTheme] = useTheme();

  const labMs = labUpdatedAt === null ? NaN : Date.parse(labUpdatedAt);
  const labKnown = !Number.isNaN(labMs);
  const themeKey: StringKey = theme === "dark" ? "light" : "dark";

  return (
    <header className="bar">
      <div className="wordmark">{t("wordmark")}</div>
      {asOf && <span className="asof measured">{t("asof", { time: fmtTime(asOf, lang) })}</span>}
      <span className="chip">{t("scope")}</span>
      {board && <AlarmChip board={board} />}
      <StatusChip status={status} asOf={asOf} />
      {board && asOf && (
        <span className="chip">
          {labKnown ? t("lastUp", { ago: agoText(asOf.getTime() - labMs, lang) }) : t("labUpdatedNone")}
        </span>
      )}
      {replaying && !paused && <span className="chip stale">{t("replay")}</span>}
      <div className="grow" />
      {controls}
      <button
        type="button"
        lang={lang === "en" ? "ar" : "en"}
        onClick={() => setLang(lang === "en" ? "ar" : "en")}
      >
        {t("langSwitch")}
      </button>
      <button type="button" onClick={toggleTheme}>
        {t(themeKey)}
      </button>
      <button type="button" aria-pressed={paused} onClick={onTogglePause}>
        {t(paused ? "resume" : "pause")}
      </button>
    </header>
  );
}
