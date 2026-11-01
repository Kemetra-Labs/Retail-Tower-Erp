/**
 * RT-474 sections 3 and 4: the server's renditions as the POS will show and
 * print them (brief §3). Nothing is re-rendered in the browser.
 *
 * - Screen: each slot's rendition at its own size (the 2x one on a high-density
 *   screen, as `srcset` would pick), centred in the approved OD-7 box, on a
 *   sample of the POS light surface. `presentation.card` alone decides the white
 *   card; the `low_contrast` warning is shown beside it, never derived from it.
 * - Receipt: the 1-bit rendition at `width_px / dpi × 25.4` mm on an 80 mm
 *   strip, with the server's dpi (OD-8 settled: no "assumed" label).
 */
import { Icon } from "@/components/icons/Icon";
import { type MessageKey, useT } from "@/i18n";
import type {
  LogoPreview,
  LogoWarning,
  ReceiptRendition,
  ScreenSlot,
} from "@/lib/tenant-branding-queries";
import { RenditionCanvas } from "./RenditionCanvas";
import {
  LOGO_SLOTS,
  receiptSizeMm,
  renditionFor,
  scaleForPixelRatio,
  warningKey,
} from "./brandingLogic";

/** OD-7 slot boxes in CSS px (RT-473 comment 13662, RT-832; brief §3 table). */
const SLOT_BOX: Record<ScreenSlot, readonly [number, number]> = {
  boot: [240, 120],
  pairing: [200, 80],
  sign_in: [128, 32],
  lock: [200, 80],
};

const SLOT_LABEL: Record<ScreenSlot, MessageKey> = {
  boot: "branding.slot.boot",
  pairing: "branding.slot.pairing",
  sign_in: "branding.slot.sign_in",
  lock: "branding.slot.lock",
};

/** OD-12: the powered-by name, a proper name kept as written. */
const POWERED_BY_NAME = "Retail Tower";

const SCREEN_WARNINGS: readonly LogoWarning[] = ["low_contrast"];
const RECEIPT_WARNINGS: readonly LogoWarning[] = [
  "receipt_high_black_coverage",
  "receipt_thin_strokes",
];

export function LogoWarnings({
  warnings,
  only,
}: Readonly<{
  warnings: readonly LogoWarning[];
  only: readonly LogoWarning[];
}>): React.JSX.Element | null {
  const t = useT();
  const shown = warnings.filter((w) => only.includes(w));
  if (shown.length === 0) return null;
  return (
    <ul className="logo-warnings">
      {shown.map((w) => (
        <li key={w} className="rtc-alert rtc-alert--warning logo-warning">
          <span className="logo-warning__text">
            <Icon name="status.warning" size="sm" className="logo-warning__icon" />
            <span className="rtc-alert__body">{t(warningKey(w))}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PoweredBy(): React.JSX.Element {
  const t = useT();
  return (
    <p className="logo-slot__powered">
      {t.rich("branding.poweredBy", { name: <bdi dir="ltr">{POWERED_BY_NAME}</bdi> })}
    </p>
  );
}

function SlotPreview({
  slot,
  preview,
  scale,
}: Readonly<{ slot: ScreenSlot; preview: LogoPreview; scale: 1 | 2 }>): React.JSX.Element | null {
  const t = useT();
  const shown = renditionFor(preview.screen, slot, 1);
  const drawn = renditionFor(preview.screen, slot, scale) ?? shown;
  if (!shown || !drawn) return null;
  const [boxWidth, boxHeight] = SLOT_BOX[slot];
  const card = preview.presentation.card ? " logo-slot__box--card" : "";
  return (
    <figure className={`logo-slot logo-slot--${slot}`}>
      <figcaption className="logo-slot__label">{t(SLOT_LABEL[slot])}</figcaption>
      <div className="logo-slot__surface">
        <div
          className={`logo-slot__box${card}`}
          style={{ inlineSize: `${String(boxWidth)}px`, blockSize: `${String(boxHeight)}px` }}
        >
          <RenditionCanvas
            key={`${preview.version}-${String(drawn.scale)}`}
            pngBase64={drawn.png_base64}
            widthPx={drawn.width_px}
            heightPx={drawn.height_px}
            displayWidth={`${String(shown.width_px)}px`}
            displayHeight={`${String(shown.height_px)}px`}
            label={t(SLOT_LABEL[slot])}
          />
        </div>
        <PoweredBy />
      </div>
    </figure>
  );
}

export function ScreenPreview({ preview }: Readonly<{ preview: LogoPreview }>): React.JSX.Element {
  const t = useT();
  const scale = scaleForPixelRatio(globalThis.devicePixelRatio ?? 1);
  return (
    <section className="logo-section" aria-labelledby="logo-screen-title">
      <h2 id="logo-screen-title" className="surface__section-title">
        {t("branding.screen.title")}
      </h2>
      <LogoWarnings warnings={preview.warnings} only={SCREEN_WARNINGS} />
      <div className="logo-preview__pos">
        {LOGO_SLOTS.map((slot) => (
          <SlotPreview key={slot} slot={slot} preview={preview} scale={scale} />
        ))}
      </div>
    </section>
  );
}

export function ReceiptPreview({
  receipt,
  version,
  warnings,
}: Readonly<{
  receipt: ReceiptRendition;
  version: string;
  warnings: readonly LogoWarning[];
}>): React.JSX.Element {
  const t = useT();
  const { widthMm, heightMm } = receiptSizeMm(receipt);
  return (
    <section className="logo-section" aria-labelledby="logo-receipt-title">
      <h2 id="logo-receipt-title" className="surface__section-title">
        {t("branding.receipt.title")}
      </h2>
      <LogoWarnings warnings={warnings} only={RECEIPT_WARNINGS} />
      <div className="logo-receipt__paper">
        <RenditionCanvas
          key={version}
          className="logo-receipt__logo"
          pngBase64={receipt.png_base64}
          widthPx={receipt.width_px}
          heightPx={receipt.height_px}
          displayWidth={`${widthMm.toFixed(2)}mm`}
          displayHeight={`${heightMm.toFixed(2)}mm`}
          label={t("branding.receipt.alt")}
        />
      </div>
      <p className="logo-receipt__caption">
        {t.rich("branding.receipt.size", {
          width: <bdi dir="ltr">{widthMm.toFixed(1)}</bdi>,
          height: <bdi dir="ltr">{heightMm.toFixed(1)}</bdi>,
        })}
      </p>
      <p className="logo-receipt__caption">{t("branding.receipt.approx")}</p>
    </section>
  );
}

/** State C: the preview is running; the slots and strip hold their place. */
export function PreviewSkeleton(): React.JSX.Element {
  const t = useT();
  return (
    <section className="logo-section" aria-busy="true" aria-labelledby="logo-loading-title">
      <h2 id="logo-loading-title" className="surface__section-title">
        {t("branding.screen.title")}
      </h2>
      <output className="sr-only">{t("branding.preview.loading")}</output>
      <div className="logo-preview__pos" aria-hidden="true">
        {LOGO_SLOTS.map((slot) => (
          <div key={slot} className={`logo-slot logo-slot--${slot}`}>
            <div className="logo-slot__surface">
              <div
                className="logo-slot__box logo-slot__box--skeleton"
                style={{
                  inlineSize: `${String(SLOT_BOX[slot][0])}px`,
                  blockSize: `${String(SLOT_BOX[slot][1])}px`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
