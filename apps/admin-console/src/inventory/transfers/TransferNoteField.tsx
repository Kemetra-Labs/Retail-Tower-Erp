/**
 * RT-1515 (PR 2, PR 3) the labelled note / reason textarea of the Transfer write
 * forms (cancel reason, dispatch note, receipt note, short-close reason): the
 * error sits at the field, the optional mark is programmatic text.
 */
import { InlineError } from "@/components/InlineError";
import { type MessageKey, useT } from "@/i18n";
import { REASON_MAX_LENGTH } from "./transferWriteLogic";

export function NoteField({
  id,
  label,
  optional = false,
  value,
  disabled,
  error,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  optional?: boolean;
  value: string;
  disabled: boolean;
  error: MessageKey | undefined;
  onChange: (value: string) => void;
}>): React.JSX.Element {
  const t = useT();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional ? (
          <>
            {" "}
            <span className="field__required">{t("transfers.write.optional")}</span>
          </>
        ) : null}
      </label>
      <textarea
        id={id}
        className="input"
        rows={2}
        dir="auto"
        maxLength={REASON_MAX_LENGTH}
        required={!optional}
        aria-required={optional ? undefined : true}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div id={`${id}-error`}>
        <InlineError message={error ? t(error) : undefined} />
      </div>
    </div>
  );
}
