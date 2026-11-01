/**
 * RT-474 section 1: the stored logo (states A, B and H). The thumbnail is the
 * server's own `pairing` rendition. Replace opens the file picker; remove starts
 * with `.btn-danger-quiet`, and `.btn-destructive` appears only in the inline
 * confirm, whose safe default focus is «إلغاء».
 */
import { GatedButton } from "@/components/GatedButton";
import { formatDateTime, useT } from "@/i18n";
import type { TenantLogo } from "@/lib/tenant-branding-queries";
import { useEffect, useRef } from "react";
import { RenditionCanvas } from "./RenditionCanvas";
import { renditionFor } from "./brandingLogic";

export interface CurrentLogoProps {
  logo: TenantLogo | null;
  /** A file is chosen: replace and remove step aside for the new logo's flow. */
  editing: boolean;
  confirmingRemove: boolean;
  removing: boolean;
  onReplace: () => void;
  onAskRemove: (open: boolean) => void;
  onRemove: () => void;
}

function RemoveConfirm({
  removing,
  onRemove,
  onCancel,
}: Readonly<{ removing: boolean; onRemove: () => void; onCancel: () => void }>): React.JSX.Element {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <section className="logo-confirm" aria-labelledby="logo-confirm-text">
      <p id="logo-confirm-text" className="logo-confirm__text">
        {t("branding.remove.confirm")}
      </p>
      <div className="surface__actions">
        <GatedButton className="btn-destructive" busy={removing} onClick={onRemove}>
          {t("branding.remove")}
        </GatedButton>
        <button ref={cancelRef} type="button" className="btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

export function CurrentLogo({
  logo,
  editing,
  confirmingRemove,
  removing,
  onReplace,
  onAskRemove,
  onRemove,
}: Readonly<CurrentLogoProps>): React.JSX.Element {
  const t = useT();
  const removeRef = useRef<HTMLButtonElement>(null);
  const thumb = logo ? renditionFor(logo.screen, "pairing", 1) : undefined;

  const closeConfirm = () => {
    onAskRemove(false);
    queueMicrotask(() => removeRef.current?.focus());
  };

  return (
    <section className="logo-section" aria-labelledby="logo-current-title">
      <h2 id="logo-current-title" className="surface__section-title">
        {t("branding.current.title")}
      </h2>
      {logo && thumb ? (
        <div className="logo-current">
          <div className="logo-current__thumb">
            <RenditionCanvas
              key={logo.version}
              pngBase64={thumb.png_base64}
              widthPx={thumb.width_px}
              heightPx={thumb.height_px}
              displayWidth={`${String(thumb.width_px)}px`}
              displayHeight={`${String(thumb.height_px)}px`}
              label={t("branding.current.alt")}
            />
          </div>
          <dl className="logo-current__meta">
            <dt className="field-row__label">{t("branding.current.updatedAt")}</dt>
            <dd className="field-row__value">{formatDateTime(logo.updated_at)}</dd>
          </dl>
        </div>
      ) : (
        <p className="content__sub">{t("branding.current.empty")}</p>
      )}

      {logo && !editing && confirmingRemove ? (
        <RemoveConfirm removing={removing} onRemove={onRemove} onCancel={closeConfirm} />
      ) : null}
      {logo && !editing && !confirmingRemove ? (
        <div className="surface__actions">
          <button type="button" className="btn-secondary" onClick={onReplace}>
            {t("branding.replace")}
          </button>
          <button
            ref={removeRef}
            type="button"
            className="btn-danger-quiet"
            onClick={() => onAskRemove(true)}
          >
            {t("branding.remove")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
