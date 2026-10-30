import { Banner } from "@/components/Banner";
import { FormErrorSummary, useSummaryFocus } from "@/components/FormErrorSummary";
import { FormField } from "@/components/FormField";
import { FormPage, FormPanel, FormSection } from "@/components/FormPage";
import { GatedButton } from "@/components/GatedButton";
import { type MessageKey, useT } from "@/i18n";
import { textField } from "@/lib/form-field";
import { type Rf2ErrorRender, mapRf2Error } from "@/lib/rf2-queries";
import { SAVED_NAVIGATION } from "@/shell/dirty-guard";
/**
 * SF-T3 — Tenant create/edit form (T018). Uncontrolled native form (research
 * R4-3; no form library). No client-side validation — the backend is the
 * validation authority (FR-004-004). Field errors render inline (aria-invalid)
 * and in the error summary (RT-971 form template); surface errors render in the
 * persistent Banner.
 *
 * Branching (mapped to the statuses the contract documents @ 62d0906):
 *   - success → route to the affected tenant detail, re-fetch
 *   - 409 slug conflict → inline on the slug field (OQ-9)
 *   - 403 → persistent banner with request_id
 *   - 404 on update → uniform not-available
 * The contract documents no 422/429, so none is handled. Slug is immutable
 * after create (TenantUpdate has no slug), so the edit form renders it read-only.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTenantMutations } from "./useTenantQueries";

export interface TenantFormProps {
  mode: "create" | "edit";
  /** Required in edit mode. */
  tenantId?: string;
  /** Backend values to prefill in edit mode. */
  initial?: { slug: string; name: string; status?: "active" | "suspended" | "pending" };
}

export function TenantForm({
  mode,
  tenantId,
  initial,
}: Readonly<TenantFormProps>): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { create, update } = useTenantMutations(tenantId);
  // The catalog key, never a translated string, so a locale switch re-renders it.
  const [slugError, setSlugError] = useState<MessageKey | undefined>();
  const [banner, setBanner] = useState<Rf2ErrorRender | undefined>();

  const summary = useSummaryFocus();

  const pending = create.isPending || update.isPending;

  function handleRender(render: Rf2ErrorRender): void {
    if (render.kind === "conflict" && render.field === "slug") {
      setSlugError(render.messageKey);
      summary.focusSummary();
      return;
    }
    setBanner(render);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSlugError(undefined);
    setBanner(undefined);
    const form = new FormData(e.currentTarget);
    const name = textField(form, "name");

    if (mode === "create") {
      const slug = textField(form, "slug");
      const res = await create.mutateAsync({ slug, name });
      if (res.status >= 400) {
        handleRender(mapRf2Error({ ...res, context: "tenant" }));
        return;
      }
      const created = res.data as { id: string } | undefined;
      if (created?.id) navigate(`/tenants/${created.id}`, { state: SAVED_NAVIGATION });
      return;
    }

    const res = await update.mutateAsync({ name });
    if (res.status >= 400) {
      handleRender(mapRf2Error({ ...res, context: "tenant" }));
      return;
    }
    if (tenantId) navigate(`/tenants/${tenantId}`, { state: SAVED_NAVIGATION });
  }

  const title = t(mode === "create" ? "tenants.form.createTitle" : "tenants.form.editTitle");
  const submitLabel = t(mode === "create" ? "tenants.form.create" : "tenants.form.saveChanges");

  const isEdit = mode === "edit";
  const backPath = isEdit && tenantId ? `/tenants/${tenantId}` : "/tenants";
  return (
    <FormPage
      back={{ to: backPath, label: t(isEdit ? "tenants.form.back" : "tenants.detail.back") }}
      title={title}
      notices={
        banner && (banner.kind === "banner" || banner.kind === "not-found") ? (
          <Banner
            variant="danger"
            message={t(banner.messageKey)}
            requestId={banner.kind === "banner" ? banner.requestId : undefined}
          />
        ) : null
      }
    >
      <FormPanel
        onSubmit={onSubmit}
        summary={
          <FormErrorSummary
            ref={summary.ref}
            entries={slugError ? [{ fieldId: "tenant-slug", message: t(slugError) }] : []}
          />
        }
        actions={
          <>
            <GatedButton type="submit" className="btn-primary" busy={pending}>
              {submitLabel}
            </GatedButton>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => navigate(backPath)}
              disabled={pending}
            >
              {t("common.cancel")}
            </button>
          </>
        }
      >
        <FormSection title={t("tenants.form.section")} columns={2}>
          <FormField id="tenant-name" label={t("tenants.field.name")} required>
            {(aria) => (
              <input
                id="tenant-name"
                name="name"
                className="input"
                defaultValue={initial?.name}
                autoComplete="off"
                {...aria}
              />
            )}
          </FormField>

          <FormField
            id="tenant-slug"
            label={t("tenants.field.slug")}
            required={!isEdit}
            error={slugError ? t(slugError) : undefined}
          >
            {(aria) => (
              <input
                id="tenant-slug"
                name="slug"
                className="input input--mono"
                dir="ltr"
                defaultValue={initial?.slug}
                readOnly={isEdit}
                autoComplete="off"
                {...aria}
              />
            )}
          </FormField>
        </FormSection>
      </FormPanel>
    </FormPage>
  );
}
