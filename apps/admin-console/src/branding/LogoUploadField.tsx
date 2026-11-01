/**
 * RT-474 section 2: the one upload field (PNG or SVG, up to 1 MB). The native
 * file input is visually hidden, because its own button text comes from the
 * browser's language, not the Console's; the visible button opens it and is the
 * control the admin focuses. A refusal is linked to that button with
 * `aria-describedby`; the page's persistent polite live region announces it
 * (this field can mount already refused, so it cannot be that region), and
 * focus stays on the control (brief §5.1). The control waits out a running
 * Retry-After like every other request control.
 */
import { GatedButton } from "@/components/GatedButton";
import { formatNumber, useT } from "@/i18n";
import type { MessageKey } from "@/i18n";

export interface LogoUploadFieldProps {
  /** A logo is stored: «شعار جديد» instead of «رفع شعار». */
  hasLogo: boolean;
  file: File | null;
  refusal: MessageKey | null;
  /** «رفع شعار» is the context's primary only before any file is chosen (state A). */
  primary: boolean;
  onOpen: () => void;
  controlRef: React.Ref<HTMLButtonElement>;
}

export const LOGO_REQUIREMENTS_ID = "logo-upload-requirements";
export const LOGO_ERROR_ID = "logo-upload-error";

export function LogoUploadField({
  hasLogo,
  file,
  refusal,
  primary,
  onOpen,
  controlRef,
}: Readonly<LogoUploadFieldProps>): React.JSX.Element {
  const t = useT();
  return (
    <section className="logo-section" aria-labelledby="logo-upload-title">
      <h2 id="logo-upload-title" className="surface__section-title">
        {t(hasLogo ? "branding.upload.titleNew" : "branding.upload.titleEmpty")}
      </h2>
      <fieldset className="logo-upload">
        <legend className="logo-upload__label">{t("branding.upload.label")}</legend>
        <div className="logo-upload__row">
          <GatedButton
            ref={controlRef}
            className={primary ? "btn-primary" : "btn-secondary"}
            aria-describedby={`${LOGO_REQUIREMENTS_ID} ${LOGO_ERROR_ID}`}
            onClick={onOpen}
          >
            {t(file || hasLogo ? "branding.upload.chooseAnother" : "branding.upload.choose")}
          </GatedButton>
          {file ? (
            <span className="logo-upload__file">
              <bdi dir="ltr">{file.name}</bdi>
              <span aria-hidden="true"> · </span>
              <bdi dir="ltr">
                {t("branding.upload.fileSize", {
                  size: formatNumber(Math.max(1, Math.ceil(file.size / 1024))),
                })}
              </bdi>
            </span>
          ) : null}
        </div>
        <p id={LOGO_REQUIREMENTS_ID} className="logo-upload__hint">
          {t("branding.upload.requirements")}
        </p>
        <p id={LOGO_ERROR_ID} className="logo-upload__error">
          {refusal ? (
            <>
              <span className="logo-upload__error-line">{t(refusal)}</span>
              <span className="logo-upload__error-line">{t("branding.refusal.unchanged")}</span>
            </>
          ) : null}
        </p>
      </fieldset>
    </section>
  );
}
