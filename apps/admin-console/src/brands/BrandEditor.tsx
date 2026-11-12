/**
 * RT-1338 brand drawer: create a brand, or rename one. One name field, a client check of what the
 * contract refuses (empty, longer than 200), and the server's answer by outcome.
 *
 * Create is replayable under one Idempotency-Key (kept by `useCreateBrand` while the answer is
 * unclear). Rename carries `expectedUpdatedAt`: a 409 `stale_write` says the brand changed and
 * offers a reload of the list; a 409 `brand_name_conflict` returns to the field, never to a banner.
 */
import { FormDrawer } from "@/components/FormDrawer";
import { FormField } from "@/components/FormField";
import { FormSection } from "@/components/FormPage";
import { type MessageKey, useT } from "@/i18n";
import type { CatalogBrand } from "@/lib/brand-queries";
import { useState } from "react";
import {
  BRAND_NAME_MAX,
  type BrandWriteOutcome,
  normalizeBrandName,
  validateBrandName,
} from "./brandLogic";
import { useCreateBrand, useRenameBrand } from "./useBrands";

export interface BrandEditorProps {
  tenantId: string;
  /** The brand to rename; absent creates a new one. */
  brand?: CatalogBrand;
  onClose: () => void;
}

type Notice = { variant: "danger" | "warning"; messageKey: MessageKey; requestId?: string };

function noticeOf(outcome: BrandWriteOutcome): Notice | undefined {
  switch (outcome.kind) {
    case "stale":
      return {
        variant: "warning",
        messageKey: "brands.write.error.stale",
        requestId: outcome.requestId,
      };
    case "gone":
      return {
        variant: "danger",
        messageKey: "brands.write.error.gone",
        requestId: outcome.requestId,
      };
    case "uncertain":
    case "failed":
      return {
        variant: outcome.kind === "uncertain" ? "warning" : "danger",
        messageKey: outcome.messageKey,
        requestId: outcome.requestId,
      };
    default:
      return undefined;
  }
}

export function BrandEditor({ tenantId, brand, onClose }: Readonly<BrandEditorProps>) {
  const t = useT();
  const create = useCreateBrand(tenantId);
  const rename = useRenameBrand(tenantId);
  const [name, setName] = useState(brand?.name ?? "");
  const [fieldError, setFieldError] = useState<MessageKey | undefined>();
  const [notice, setNotice] = useState<Notice | undefined>();
  const pending = create.isPending || rename.isPending;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setNotice(undefined);
    const invalid = validateBrandName(name);
    setFieldError(invalid);
    if (invalid) return;
    const clean = normalizeBrandName(name);
    try {
      const outcome = brand
        ? await rename.mutateAsync({
            brandId: brand.brandId,
            name: clean,
            expectedUpdatedAt: brand.updatedAt,
          })
        : await create.mutateAsync(clean);
      if (outcome.kind === "ok") {
        onClose();
      } else if (outcome.kind === "nameTaken") {
        setFieldError("brands.form.nameTaken");
      } else {
        setNotice(noticeOf(outcome));
      }
    } catch {
      // The request never completed: the write may have landed; the same attempt can be repeated.
      setNotice({ variant: "warning", messageKey: "brands.write.error.uncertain" });
    }
  }

  return (
    <FormDrawer
      title={t(brand ? "brands.form.renameTitle" : "brands.form.createTitle")}
      onClose={onClose}
      dismissible={!pending}
      onSubmit={(e) => void submit(e)}
      submitLabel={t(brand ? "brands.form.saveRename" : "brands.form.saveCreate")}
      pending={pending}
      notice={notice}
    >
      <FormSection>
        <FormField
          id="brand-name"
          label={t("brands.form.name")}
          hint={t("brands.form.nameHint", { max: BRAND_NAME_MAX })}
          required
          announceError
          error={fieldError ? t(fieldError) : undefined}
        >
          {(aria) => (
            <input
              id="brand-name"
              name="name"
              className="input"
              dir="auto"
              autoComplete="off"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFieldError(undefined);
              }}
              {...aria}
            />
          )}
        </FormField>
      </FormSection>
    </FormDrawer>
  );
}
