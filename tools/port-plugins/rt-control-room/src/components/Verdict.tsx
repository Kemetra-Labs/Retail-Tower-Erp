import { useLang } from "../i18n/LangContext";
import { pick, type StringKey } from "../i18n/strings";
import type { Board, Collection, Light } from "../model/types";
import type { BoardStatus } from "../state/useBoard";
import { StaleSentence } from "./StaleSentence";
import { staleSources } from "./staleInfo";

type Tone = Light["tone"];

type LightKey = "cashier" | "backend" | "accounts";

// The mockup's 18 x 18 stroke icons (its ICONS table); shape, not only colour, tells the tones apart.
// A fault uses the icon of what usually breaks there: the cut cable for Accounts (the mockup's pick),
// the bell for a Backend check in alert, the broken code for a screen that failed to draw.
// A neutral light is "no errors reported", not a pass: it draws a plain dash, never a check mark.
const NEUTRAL_ICON = "M5 9h8";
const UNKNOWN_ICON = "M7 7a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M9 13v.5";
const FAULT_ICON: Record<LightKey, string> = {
  accounts: "M1 9h5M12 9h5M6 5v8M12 5v8M9 3l-1 3M9 15l1-3",
  backend: "M9 2a4 4 0 0 0-4 4v3l-1.5 3h11L13 9V6a4 4 0 0 0-4-4zM7.5 15a1.5 1.5 0 0 0 3 0",
  cashier: "M6 5L2 9l4 4M12 5l4 4-4 4M10 3L8 15",
};
const iconOf = (tone: Tone, key: LightKey): string =>
  tone === "fault" ? FAULT_ICON[key] : tone === "unknown" ? UNKNOWN_ICON : NEUTRAL_ICON;
const TONE_COLOR: Record<Tone, string> = {
  fault: "var(--color-bad)",
  unknown: "var(--color-stale)",
  neutral: "var(--color-ok)",
};

const LIGHTS = [
  ["cashier", "lightCashier"],
  ["backend", "lightBackend"],
  ["accounts", "lightAccounts"],
] as const satisfies readonly (readonly [LightKey, StringKey])[];

function ToneIcon({ tone, lightKey }: { tone: Tone; lightKey: LightKey }) {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        d={iconOf(tone, lightKey)}
        fill="none"
        stroke={TONE_COLOR[tone]}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** No board to draw: busy placeholders while loading, a plain message when Port cannot be read. No figure, no green. */
function Unavailable({ status }: { status: BoardStatus }) {
  const { t } = useLang();
  const loading = status !== "error";
  return (
    <section className="verdict unavailable" aria-busy={loading}>
      <div role="status">
        <div className="k">{t(loading ? "stateLoading" : "stateError")}</div>
        <div className="line">{t(loading ? "stateLoadingNote" : "stateErrorNote")}</div>
        {loading && (
          <div className="skel" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
    </section>
  );
}

/** The sentence and the three lights (Cashier app, Backend, Accounts) of `board.verdict`. */
export function Verdict({
  board,
  status,
  failed,
  unavailable,
}: {
  board: Board | null;
  status: BoardStatus;
  failed?: readonly Collection[];
  /** Optional blueprints Port does not share with this widget (403 or 404): named, not hidden. */
  unavailable?: readonly Collection[];
}) {
  const { lang, t } = useLang();
  if (!board) return <Unavailable status={status} />;

  const { sentence, lights } = board.verdict;
  return (
    <section className="verdict" aria-label={t("lightCashier") + ", " + t("lightBackend") + ", " + t("lightAccounts")}>
      <div>
        <div className="line">{pick(sentence, lang)}</div>
        <div className="gapnote">{t("gapNote")}</div>
        {status === "stale" && (
          <div className="gapnote staleNote">
            {t("stateStaleNote")} <StaleSentence failed={failed} />
          </div>
        )}
        {unavailable !== undefined && unavailable.length > 0 && (
          <div className="gapnote" data-not-available>
            {t("notAvailableNote", { list: staleSources(unavailable).map((key) => t(key)).join(", ") })}
          </div>
        )}
      </div>
      {LIGHTS.map(([key, label]) => {
        const light = lights[key];
        return (
          <div key={key} className={`light tone-${light.tone}`} data-tone={light.tone}>
            <div className="k">{t(label)}</div>
            <div className="v">
              <ToneIcon tone={light.tone} lightKey={key} />
              <span>{pick(light.text, lang)}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
