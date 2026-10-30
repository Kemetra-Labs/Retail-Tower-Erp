import { FormField } from "@/components/FormField";
import { type MessageKey, useLocale, useT } from "@/i18n";
import { timezoneOptions, zoneLabel } from "@/lib/timezones";
/**
 * The store form's «المنطقة الزمنية» select (RT-477; screens 16 and 17). On
 * create it is required with Africa/Cairo preselected; on edit it starts on the
 * store's stored zone. A store's stored zone is always one of the options, so a
 * zone outside the lists is shown, not replaced by the first option.
 */
import { useMemo } from "react";

export interface TimezoneFieldProps {
  value: string;
  onChange: (zone: string) => void;
  /** Create marks the field required; edit does not (design 17). */
  required: boolean;
  /** The store's stored zone on edit, kept in the options. */
  current?: string;
  error?: MessageKey;
}

export function TimezoneField({
  value,
  onChange,
  required,
  current,
  error,
}: Readonly<TimezoneFieldProps>): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const { common, other } = useMemo(() => timezoneOptions(current), [current]);
  const option = (zone: string) => (
    <option key={zone} value={zone}>
      {zoneLabel(zone, locale)}
    </option>
  );

  return (
    <FormField
      id="store-timezone"
      label={t("stores.field.timezone")}
      required={required}
      hint={t(required ? "stores.form.timezoneHintCreate" : "stores.form.timezoneHintEdit")}
      error={error ? t(error) : undefined}
    >
      {(aria) => (
        <select
          id="store-timezone"
          name="timezone"
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        >
          <optgroup label={t("stores.form.timezoneGroupCommon")}>{common.map(option)}</optgroup>
          <optgroup label={t("stores.form.timezoneGroupOther")}>{other.map(option)}</optgroup>
        </select>
      )}
    </FormField>
  );
}
