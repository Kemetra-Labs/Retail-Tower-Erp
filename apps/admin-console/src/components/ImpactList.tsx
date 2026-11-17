/**
 * The parts of an impact preview the owner's force-action dialogs (RT-1440, RT-1441) share. The
 * server's codes are already mapped to catalog keys by the caller; nothing here judges them.
 *
 *   - `ImpactList`: one headed list (what will change, what will not). When the server named a code
 *     this build has no copy for, `unknownKey` says so instead of hiding it. `className` carries each
 *     dialog's own spacing.
 *   - `ImpactFootnotes`: the caveats (what the server cannot see) and the snapshot line ("as of …,
 *     a snapshot, not a reservation").
 */
import { DateTime, type MessageKey, useT } from "@/i18n";

export function ImpactList({
  className,
  heading,
  keys,
  unknownKey,
}: Readonly<{
  className: string;
  heading: string;
  keys: readonly MessageKey[];
  unknownKey?: MessageKey;
}>): React.JSX.Element {
  const t = useT();
  return (
    <section className={className}>
      <h3>{heading}</h3>
      <ul>
        {keys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
        {unknownKey ? <li>{t(unknownKey)}</li> : null}
      </ul>
    </section>
  );
}

export function ImpactFootnotes({
  caveats,
  snapshotKey,
  evaluatedAt,
  timeZone,
}: Readonly<{
  caveats: readonly MessageKey[];
  /** The catalog line that takes `{time}`. */
  snapshotKey: MessageKey;
  evaluatedAt: string;
  timeZone?: string;
}>): React.JSX.Element {
  const t = useT();
  return (
    <>
      <ul className="confirm-modal__caveats">
        {caveats.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <p className="device-quiet">
        {t.rich(snapshotKey, {
          time: (
            <bdi dir="ltr">
              <DateTime value={evaluatedAt} timeZone={timeZone} />
            </bdi>
          ),
        })}
      </p>
    </>
  );
}
