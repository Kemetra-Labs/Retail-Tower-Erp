import type { AlarmKind } from "../model/types";
import { ICONS } from "./room/icons";

/** The 18 x 18 alarm icon of a kind. Unknown is amber, a fault is red (the `.ic` classes). */
export function KindIcon({ kind }: { kind: AlarmKind | "unknown" }) {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" className="kind-icon">
      <path d={ICONS[kind]} className={kind === "unknown" ? "ic unk" : "ic"} />
    </svg>
  );
}
