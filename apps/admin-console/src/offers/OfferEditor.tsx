/**
 * RT-1338 offer editor page body: the form (names, X / Y / P, the include and exclude rule sets,
 * stores, schedule, offline policy) and, once the offer is saved, the Preview → Publish controls.
 * The state and the three steps live in `useOfferEditor`; this component only lays them out.
 *
 * There is no error before the first Save; after a blocked Save the summary lists every error in
 * field order, takes focus, and clears live as fields are fixed. The editor holds no business logic.
 */
import { useCatalogBrands } from "@/brands/useBrands";
import { useCatalogCategories } from "@/catalog/useCatalog";
import { FormErrorSummary, useSummaryFocus } from "@/components/FormErrorSummary";
import { FormPage, FormPanel, FormSection } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { useT } from "@/i18n";
import type { Offer } from "@/lib/offer-queries";
import { useState } from "react";
import { useNavigate } from "react-router";
import { OFFER_FIELD_IDS, OfferFormFields } from "./OfferFormFields";
import { OfferPublishSection } from "./OfferPublishSection";
import { OfferRuleSet } from "./OfferRuleSet";
import { OFFER_FIELD_ORDER, type OfferFormErrors } from "./offerFormLogic";
import type { OfferAccess } from "./offerLogic";
import type { OfferNotice } from "./offerOutcomes";
import { useOfferEditor } from "./useOfferEditor";
import type { OfferWrites } from "./useOffers";
import { useProductNames } from "./useProductNames";

type Store = { id: string; name?: string };

export interface OfferEditorProps {
  tenantId: string;
  /** The saved offer; absent while creating. */
  offer?: Offer;
  access: OfferAccess;
  roster: readonly Store[];
  writes: OfferWrites;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Banners above the form: the last write's outcome, and the page's own. */
  notices: React.ReactNode;
  /** Sections beside the form that belong to the page (facts, lifecycle). */
  after?: React.ReactNode;
  onNotice: (notice: OfferNotice | undefined) => void;
  /** The draft moved under the editor (409): read the offer again. */
  onStale: () => void;
}

/** The error summary's entries, in field order (none before the first Save). */
function summaryEntries(
  errors: OfferFormErrors,
  submitted: boolean,
  t: ReturnType<typeof useT>,
): { fieldId: string; message: string }[] {
  if (!submitted) return [];
  return OFFER_FIELD_ORDER.flatMap((field) => {
    const e = errors[field];
    return e ? [{ fieldId: OFFER_FIELD_IDS[field], message: t(e.messageKey, e.params) }] : [];
  });
}

/** The catalog lists the rule sets choose from, and the names of the products already chosen. */
function useRuleChoices(
  tenantId: string,
  includeProductIds: readonly string[],
  excludeProductIds: readonly string[],
) {
  const categories = useCatalogCategories(tenantId, true);
  const brands = useCatalogBrands(tenantId, true);
  const [knownNames, setKnownNames] = useState<Record<string, string>>({});
  return {
    tenantId,
    categories: categories.categories.map((c) => ({ id: c.categoryId, name: c.name })),
    brands: brands.brands.map((b) => ({ id: b.brandId, name: b.name })),
    listsKnown: !(categories.isLoading || categories.failed || brands.isLoading || brands.failed),
    // One lookup budget per set, so the include set's unread ids never starve the exclude set's.
    includeNames: useProductNames(tenantId, includeProductIds, knownNames),
    excludeNames: useProductNames(tenantId, excludeProductIds, knownNames),
    onProductNamed: (id: string, name: string) => setKnownNames((k) => ({ ...k, [id]: name })),
  };
}

export function OfferEditor({
  tenantId,
  offer,
  access,
  roster,
  writes,
  title,
  subtitle,
  notices,
  after,
  onNotice,
  onStale,
}: Readonly<OfferEditorProps>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { ref: summaryRef, focusSummary } = useSummaryFocus();
  const editor = useOfferEditor({ offer, access, writes, onNotice, onStale, focusSummary });
  const { values, change, shown } = editor;
  const { includeNames, excludeNames, ...rules } = useRuleChoices(
    tenantId,
    values.include.productIds,
    values.exclude.productIds,
  );

  const publishSection = offer ? (
    <OfferPublishSection
      busy={editor.busy}
      canPreview={editor.canPreview}
      canPublish={editor.canPublish}
      mayPublish={access.canPublish}
      hint={editor.publishHint}
      preview={editor.livePreview}
      onPreview={() => void editor.runPreview()}
      onPublish={() => void editor.publish()}
      onSimulate={(request) => void editor.runPreview(request)}
    />
  ) : null;

  return (
    <FormPage
      back={{ to: "/offers", label: t("offers.page.back") }}
      title={title}
      subtitle={subtitle}
      notices={notices}
      after={
        <>
          {publishSection}
          {after}
        </>
      }
    >
      <FormPanel
        className="offer-form"
        onSubmit={(e) => {
          e.preventDefault();
          void editor.save();
        }}
        summary={
          <FormErrorSummary
            ref={summaryRef}
            entries={summaryEntries(editor.errors, editor.submitted, t)}
          />
        }
        actions={
          <>
            <GatedButton type="submit" className="btn-primary" busy={editor.busy === "save"}>
              {t("offers.save.action")}
            </GatedButton>
            <button type="button" className="btn-ghost" onClick={() => navigate("/offers")}>
              {t("common.cancel")}
            </button>
          </>
        }
      >
        <OfferFormFields
          values={values}
          errors={shown}
          onChange={change}
          roster={roster}
          tenantWide={access.tenantWide}
        />
        <FormSection title={t("offers.rules.title")}>
          <p className="field__hint" id={OFFER_FIELD_IDS.include}>
            {t("offers.rules.exclusionWins")}
          </p>
          {shown.include ? (
            <p className="field__error" role="alert">
              {t(shown.include.messageKey, shown.include.params)}
            </p>
          ) : null}
          <OfferRuleSet
            kind="include"
            value={values.include}
            onChange={(next) => change("include", next)}
            productNames={includeNames}
            {...rules}
          />
          <OfferRuleSet
            kind="exclude"
            value={values.exclude}
            onChange={(next) => change("exclude", next)}
            productNames={excludeNames}
            {...rules}
          />
        </FormSection>
      </FormPanel>
    </FormPage>
  );
}
