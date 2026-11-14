import { useLang } from "../i18n/LangContext";
import type { Collection } from "../model/types";
import { alarmsMayBeMissing, staleSources } from "./staleInfo";

/**
 * The second half of the stale note. "Alarms may be missing" only when the error tracker or the
 * Datadog monitors could not be read; otherwise it names the panels that hold older data.
 */
export function StaleSentence({ failed }: { failed?: readonly Collection[] }) {
  const { t } = useLang();
  if (alarmsMayBeMissing(failed)) return <>{t("alarmsMayBeMissing")}</>;
  const list = staleSources(failed).map((key) => t(key)).join(", ");
  return <>{t("staleOldData", { list })}</>;
}
