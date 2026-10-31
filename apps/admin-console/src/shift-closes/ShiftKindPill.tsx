import { useT } from "@/i18n";
/**
 * RT-1015: the close kind as a v4.0 pill. The kind is always its word; a forced
 * (administrative) close also takes the warning variant, which only reinforces
 * the word. An unknown kind keeps its localized fallback, never the raw code.
 */
import { closeKindKey } from "./shiftCloseLogic";

export function KindPill({ close }: Readonly<{ close: { closeKind: string } }>): React.JSX.Element {
  const t = useT();
  const forced = close.closeKind === "forced";
  return (
    <span className={`badge shift-kind${forced ? " badge--warning" : ""}`}>
      {t(closeKindKey(close))}
    </span>
  );
}
