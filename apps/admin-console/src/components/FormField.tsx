/**
 * RT-971 (canvas «نموذج»): one labelled field of the form template. The label
 * sits above the control, then the hint, then the inline error. Promoted from
 * the RT-768 product form's `Field`, which the identifier drawer shares too.
 *
 * The control is a render prop that receives its ARIA: `aria-required` when the
 * field is required, `aria-invalid` and `aria-describedby` (hint, warning,
 * error) when they apply. The required mark is drawn by CSS on
 * `.field--required` (`content: "*" / ""`, no alt text), so it is not part of the
 * label's text or its accessible name; `aria-required` tells assistive tech.
 *
 * The inline error is NOT a live region by default: on a full-page form the
 * error summary announces a blocked submit, so the same words are not spoken
 * twice. A form without a summary (a drawer, an inline panel form) passes
 * `announceError` so a server error on one field is still announced.
 *
 * `warning` is a non-blocking notice (never `aria-invalid`) in a polite status
 * region (`<output>`) that is always rendered, so its appearance is announced;
 * it describes the field only while it has text.
 */
import "./form-page.css";
import "./inline-error.css";

export interface FormFieldProps {
  id: string;
  /** The visible label. A field without a single control (a radio group) uses `FormSection`. */
  label: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
  warning?: string | null;
  /** Already-translated error text, the same words as its summary entry. */
  error?: string;
  /** Announce the error itself (a form with no error summary). */
  announceError?: boolean;
  /** A field that spans both columns of a two-column section. */
  wide?: boolean;
  children: (aria: React.AriaAttributes) => React.ReactNode;
}

export function FormField({
  id,
  label,
  required = false,
  hint,
  warning,
  error,
  announceError = false,
  wide = false,
  children,
}: Readonly<FormFieldProps>): React.JSX.Element {
  const describedBy = [
    hint ? `${id}-hint` : null,
    warning ? `${id}-warning` : null,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={["field", required && "field--required", wide && "field--wide"]
        .filter(Boolean)
        .join(" ")}
    >
      <label htmlFor={id}>{label}</label>
      {children({
        "aria-required": required ? true : undefined,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy || undefined,
      })}
      {hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
      {warning === undefined ? null : (
        <output id={`${id}-warning`} className="field__warning">
          {warning}
        </output>
      )}
      {error ? (
        <span
          id={`${id}-error`}
          className="rtc-inline-error"
          role={announceError ? "alert" : undefined}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
