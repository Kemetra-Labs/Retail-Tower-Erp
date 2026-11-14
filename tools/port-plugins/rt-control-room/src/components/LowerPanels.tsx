import type { Board } from "../model/types";
import { CiStrip } from "./CiStrip";
import { HealthChecks } from "./HealthChecks";
import { JiraRiver } from "./JiraRiver";
import { PerStation } from "./PerStation";
import type { Freshness } from "./PanelHead";

/**
 * The four lower panels in one wrapper, so Story mode can hide them all with
 * one condition (`{mode === "ops" && <LowerPanels … />}`) instead of editing them.
 */
export function LowerPanels({ board, fresh }: { board: Board; fresh?: Freshness }) {
  return (
    <div className="lower" data-lower-panels>
      <PerStation board={board} fresh={fresh} />
      <JiraRiver board={board} fresh={fresh} />
      <CiStrip board={board} fresh={fresh} />
      <HealthChecks board={board} fresh={fresh} />
    </div>
  );
}
