/**
 * RT-1338 "Validate → Preview → Publish" controls of a saved offer: Preview is offered while the form
 * is clean; Publish only after a publishable preview of the current draft revision, and only to a
 * role that may publish. The reason it is not ready yet is said under the buttons.
 */
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";
import type { OfferPreview, OfferSimulationRequest } from "@/lib/offer-queries";
import { OfferPreviewPanel } from "./OfferPreviewPanel";
import type { PublishHint } from "./useOfferEditor";

export interface OfferPublishSectionProps {
  busy: "save" | "preview" | "publish" | null;
  canPreview: boolean;
  canPublish: boolean;
  /** The role may publish at all (the button is shown, perhaps disabled). */
  mayPublish: boolean;
  hint: PublishHint | undefined;
  preview: OfferPreview | null;
  onPreview: () => void;
  onPublish: () => void;
  onSimulate: (request: OfferSimulationRequest) => void;
}

export function OfferPublishSection({
  busy,
  canPreview,
  canPublish,
  mayPublish,
  hint,
  preview,
  onPreview,
  onPublish,
  onSimulate,
}: Readonly<OfferPublishSectionProps>): React.JSX.Element {
  const t = useT();
  return (
    <section className="offer-publish" aria-label={t("offers.publish.title")}>
      <h3 className="offer-rule__legend">{t("offers.publish.title")}</h3>
      <div className="offer-preview__actions">
        <GatedButton
          type="button"
          className="btn-secondary"
          busy={busy === "preview"}
          disabled={!canPreview}
          onClick={onPreview}
        >
          {t("offers.preview.run")}
        </GatedButton>
        {mayPublish ? (
          <GatedButton
            type="button"
            className="btn-primary"
            busy={busy === "publish"}
            disabled={!canPublish}
            onClick={onPublish}
          >
            {t("offers.publish.action")}
          </GatedButton>
        ) : null}
      </div>
      {hint ? <p className="field__hint">{t(hint)}</p> : null}
      {preview ? (
        <OfferPreviewPanel
          preview={preview}
          simulating={busy === "preview"}
          onSimulate={onSimulate}
        />
      ) : null}
    </section>
  );
}
