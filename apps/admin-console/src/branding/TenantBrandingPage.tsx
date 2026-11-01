/**
 * RT-474 — «هوية المؤسسة» (`/tenants/:tenantId/branding`): upload, replace or
 * remove the tenant's one logo, and see before saving exactly what the POS will
 * show on its four screens and print on the receipt (brief
 * docs/design/rt474-tenant-logo, frames 47-56).
 *
 * Owner / tenant_admin of the active tenant only; anyone else gets the no-access
 * screen and nothing is requested. The server answers the same non-disclosing
 * 404, which also shows no-access. Every image check is Backend-Core's; the
 * previews are its renditions. Warnings never block saving.
 */
import { NoAccess } from "@/auth/NoAccess";
import { BackArrow } from "@/components/BackArrow";
import { Banner } from "@/components/Banner";
import { GatedButton } from "@/components/GatedButton";
import { ListState } from "@/components/ListState";
import { PageHeader } from "@/components/PageHeader";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { useT } from "@/i18n";
import type { TenantBranding } from "@/lib/tenant-branding-queries";
import { useSignOut } from "@/shell/useSignOut";
import { useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { CurrentLogo } from "./CurrentLogo";
import { PreviewSkeleton, ReceiptPreview, ScreenPreview } from "./LogoPreviews";
import { LogoUploadField } from "./LogoUploadField";
import { canManageLogo } from "./brandingAccess";
import { type EditorNotice, type LogoEditor, useLogoEditor } from "./useLogoEditor";
import { type BrandingRead, useStoreBranding, useTenantBranding } from "./useTenantBranding";
import "../shell/surface.css";
import "./branding.css";

const ACCEPT = ".png,.svg,image/png,image/svg+xml";

function NoticeBanner({
  notice,
  onReload,
}: Readonly<{ notice: EditorNotice | null; onReload: () => void }>): React.JSX.Element | null {
  const t = useT();
  if (!notice) return null;
  switch (notice.kind) {
    case "saved":
      return <Banner variant="success" message={t("branding.saved")} />;
    case "removed":
      return <Banner variant="success" message={t("branding.removed")} />;
    case "conflict":
      return (
        <Banner
          variant="warning"
          message={t("branding.conflict")}
          action={
            <button type="button" className="btn-secondary" onClick={onReload}>
              {t("branding.conflict.reload")}
            </button>
          }
        />
      );
    case "session":
      return <Banner variant="danger" message={t("branding.sessionExpired")} />;
    case "failed":
      return (
        <Banner
          variant="danger"
          message={t(notice.requestId ? "errors.generic" : "errors.server")}
          requestId={notice.requestId}
        />
      );
  }
}

function EditorActions({ editor }: Readonly<{ editor: LogoEditor }>): React.JSX.Element {
  const t = useT();
  const { phase } = editor;
  return (
    <div className="surface__actions logo-actions">
      {phase.kind === "retry" ? (
        <GatedButton className="btn-secondary" onClick={editor.rerunPreview}>
          {t("branding.preview.retry")}
        </GatedButton>
      ) : null}
      <GatedButton
        className="btn-primary"
        disabled={phase.kind !== "preview"}
        busy={editor.busy === "save"}
        onClick={() => void editor.save()}
      >
        {t("branding.save")}
      </GatedButton>
      <button type="button" className="btn-ghost" onClick={editor.cancel}>
        {t("common.cancel")}
      </button>
    </div>
  );
}

function BrandingEditor({
  tenantId,
  branding,
  onReload,
}: Readonly<{
  tenantId: string;
  branding: TenantBranding;
  onReload: () => void;
}>): React.JSX.Element {
  const signOut = useSignOut();
  const editor = useLogoEditor(tenantId, branding.revision, useStoreBranding(tenantId));
  const inputRef = useRef<HTMLInputElement>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const { phase, notice } = editor;
  const file = phase.kind === "idle" ? null : phase.file;
  const refusal = phase.kind === "refused" ? phase.messageKey : null;
  const hasLogo = branding.logo !== null;

  // A save or removal ends the flow: focus moves to its outcome line.
  useEffect(() => {
    if (notice?.kind === "saved" || notice?.kind === "removed") noticeRef.current?.focus();
  }, [notice]);

  if (editor.noAccess) return <NoAccess onSignOut={signOut} />;

  const openPicker = () => inputRef.current?.click();

  return (
    <>
      <div ref={noticeRef} tabIndex={-1} className="logo-notices">
        <NoticeBanner
          notice={notice}
          onReload={() => {
            editor.clearConflict();
            onReload();
          }}
        />
      </div>

      <CurrentLogo
        logo={branding.logo}
        editing={file !== null}
        confirmingRemove={editor.confirmingRemove}
        removing={editor.busy === "remove"}
        onReplace={openPicker}
        onAskRemove={editor.askRemove}
        onRemove={() => void editor.remove()}
      />

      <form key={editor.formKey} className="sr-only" onSubmit={(e) => e.preventDefault()}>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          aria-invalid={refusal ? true : undefined}
          onChange={(e) => {
            const chosen = e.currentTarget.files?.[0];
            if (chosen) editor.choose(chosen);
          }}
        />
      </form>

      {!hasLogo || file ? (
        <LogoUploadField
          hasLogo={hasLogo}
          file={file}
          refusal={refusal}
          primary={!hasLogo && !file}
          onOpen={openPicker}
          controlRef={controlRef}
        />
      ) : null}

      {phase.kind === "previewing" ? <PreviewSkeleton /> : null}
      {phase.kind === "preview" ? (
        <>
          <ScreenPreview preview={phase.preview} />
          <ReceiptPreview
            receipt={phase.preview.receipt}
            version={phase.preview.version}
            warnings={phase.preview.warnings}
          />
        </>
      ) : null}

      {file ? <EditorActions editor={editor} /> : null}
    </>
  );
}

function BrandingBody({
  tenantId,
  result,
  refetch,
}: Readonly<{
  tenantId: string;
  result: BrandingRead | undefined;
  refetch: () => void;
}>): React.JSX.Element | null {
  const t = useT();
  if (!result) return null;
  switch (result.kind) {
    case "ok":
      return <BrandingEditor tenantId={tenantId} branding={result.data} onReload={refetch} />;
    case "session":
      return <Banner variant="danger" message={t("branding.sessionExpired")} />;
    case "failed":
    case "rateLimited":
    case "refused":
    case "conflict":
      return (
        <Banner
          variant="danger"
          message={t("branding.loadFailed")}
          requestId={result.kind === "failed" ? result.requestId : undefined}
          action={
            <GatedButton className="btn-secondary" onClick={refetch}>
              {t("branding.retry")}
            </GatedButton>
          }
        />
      );
    case "noAccess":
      return null;
  }
}

export function TenantBrandingPage(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const { tenantId = "" } = useParams();
  const { context } = useActiveContextValue();
  const allowed =
    canManageLogo(context?.active_role_code) && context?.active_tenant?.id === tenantId;
  const read = useTenantBranding(tenantId, allowed);

  if (!allowed || read.result?.kind === "noAccess") return <NoAccess onSignOut={signOut} />;

  return (
    <div className="surface logo-page" data-testid="tenant-branding">
      <Link to={`/tenants/${tenantId}`} className="surface__back">
        <BackArrow /> {t("branding.back")}
      </Link>
      <PageHeader title={t("branding.title")} />
      {read.isLoading ? (
        <ListState state="loading" label={t("branding.loadingNoun")} />
      ) : (
        <BrandingBody
          tenantId={tenantId}
          result={read.result}
          refetch={() => void read.refetch()}
        />
      )}
    </div>
  );
}
