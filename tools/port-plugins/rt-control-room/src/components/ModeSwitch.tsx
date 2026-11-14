import { forwardRef } from "react";
import { useLang } from "../i18n/LangContext";

export type Mode = "ops" | "story";

export type ModeSwitchProps = {
  mode: Mode;
  onMode: (mode: Mode) => void;
  /** Whether the guided tour is open. */
  tourOn: boolean;
  /** Starts the tour, or ends it when it is open. */
  onTour: () => void;
};

/**
 * The Ops | Story switch (two pressed-state buttons in one group) and, in Story
 * mode only, the button that starts the guided tour. The tour button takes a
 * ref so focus can return to it when the tour ends.
 */
export const ModeSwitch = forwardRef<HTMLButtonElement, ModeSwitchProps>(function ModeSwitch(
  { mode, onMode, tourOn, onTour },
  tourRef,
) {
  const { t } = useLang();
  return (
    <>
      <div className="mode-switch" role="group" aria-label={t("modeAria")}>
        <button type="button" aria-pressed={mode === "ops"} onClick={() => onMode("ops")}>
          {t("modeOps")}
        </button>
        <button type="button" aria-pressed={mode === "story"} onClick={() => onMode("story")}>
          {t("modeStory")}
        </button>
      </div>
      {mode === "story" && (
        <button type="button" ref={tourRef} aria-pressed={tourOn} onClick={onTour}>
          {t("tourName")}
        </button>
      )}
    </>
  );
});
