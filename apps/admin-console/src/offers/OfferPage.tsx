/**
 * RT-1338 offer page (RT-286 S6): `/offers/new` creates, `/offers/:offerId` opens one. For a role
 * that may manage it is the editor (Save → Preview → Publish) with the facts and the lifecycle
 * controls beside it; for a role that may only read (a store_manager) it is the facts, with Pause
 * for their own stores. Reads are never assumed complete for a store_manager: the server filters the
 * stores and pauses to theirs.
 *
 * Gate first: no active tenant → a scope prompt; a role that cannot read, or cannot create on
 * `/offers/new`, gets NoAccess and nothing is requested. Errors show catalog copy and the request id.
 *
 * The editor is keyed by the offer and its draft revision, so a saved, published or reloaded draft
 * remounts it on the server's answer: what is on screen is never older than the last answer.
 */
import { NoAccess } from "@/auth/NoAccess";
import { Banner } from "@/components/Banner";
import { FormPage } from "@/components/FormPage";
import { ListState } from "@/components/ListState";
import { ScopePrompt } from "@/components/ScopePrompt";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { type MessageKey, useT } from "@/i18n";
import { getLocale } from "@/i18n/locale";
import type { Offer, OfferVersion } from "@/lib/offer-queries";
import { usePayerStores } from "@/payers/usePayerStores";
import type { ScopeMembership } from "@/shell/scope-stores";
import { useSignOut } from "@/shell/useSignOut";
import { useState } from "react";
import { useParams } from "react-router";
import { OfferEditor } from "./OfferEditor";
import { OfferFacts } from "./OfferFacts";
import { OfferLifecycle } from "./OfferLifecycle";
import { OfferConflictList } from "./OfferPreviewPanel";
import { type OfferAccess, type OfferActions, offerAccess, offerActions } from "./offerLogic";
import { type OfferNotice, noticeOf } from "./offerOutcomes";
import {
  type OfferReadError,
  type OfferWrites,
  useOffer,
  useOfferVersions,
  useOfferWrites,
} from "./useOffers";
import "../shell/surface.css";
import "./offers.css";

const READ_ERROR: Record<OfferReadError["kind"], MessageKey> = {
  session: "offers.error.session",
  forbidden: "offers.error.forbidden",
  notFound: "offers.page.notFound",
  generic: "offers.page.loadFailed",
};

/** The offer's name in the active locale: the draft's, else the published version's. */
function nameOf(offer: Offer | undefined): string | undefined {
  const definition = offer?.draft?.definition ?? offer?.currentVersion?.definition;
  if (!definition) return undefined;
  return getLocale() === "en" && definition.nameEn ? definition.nameEn : definition.nameAr;
}

function NoticeBanner({ notice }: Readonly<{ notice: OfferNotice | undefined }>) {
  const t = useT();
  if (!notice) return null;
  return (
    <>
      <Banner
        variant={notice.variant}
        message={t(notice.messageKey)}
        requestId={notice.requestId}
      />
      {notice.conflicts ? <OfferConflictList conflicts={notice.conflicts} /> : null}
    </>
  );
}

/** The facts of a saved offer and its lifecycle controls (beside the editor, or alone when read-only). */
function OfferSide({
  offer,
  actions,
  access,
  roster,
  versions,
  storeScoped,
  writes,
  onNotice,
}: Readonly<{
  offer: Offer;
  actions: OfferActions;
  access: OfferAccess;
  roster: readonly { id: string; name?: string }[];
  versions: readonly OfferVersion[];
  storeScoped: boolean;
  writes: OfferWrites;
  onNotice: (notice: OfferNotice) => void;
}>): React.JSX.Element {
  return (
    <>
      <OfferFacts
        offer={offer}
        roster={roster}
        access={access}
        actions={actions}
        versions={versions}
        storeScoped={storeScoped}
        onResumeStore={(storeId) =>
          void writes
            .resume(offer.offerId, { storeIds: [storeId] })
            .then((outcome) => onNotice(noticeOf(outcome, "offers.resume.done")))
        }
      />
      <OfferLifecycle
        offer={offer}
        access={access}
        roster={roster}
        writes={writes}
        onNotice={onNotice}
      />
    </>
  );
}

/** The active tenant, the caller's offer access, and whether this route may open at all. */
function usePageAccess(creating: boolean) {
  const { context } = useActiveContextValue();
  const tenant = context?.active_tenant ?? null;
  const tenantId = tenant?.id ?? null;
  const membership = context?.memberships?.find((m) => m.tenant_id === tenantId) as
    | ScopeMembership
    | undefined;
  const role = context?.active_role_code;
  const access = offerAccess(role, membership?.store_access_kind);
  return {
    tenant,
    tenantId,
    access,
    allowed: creating ? access.canManage : access.canRead,
    // The server filters a store_manager's reads (and a bounded membership's) to their own stores.
    storeScoped: !access.tenantWide || role === "store_manager",
  };
}

/** The page while the offer is not loaded yet: a spinner, or why it could not be read. */
function OfferLoading({ error }: Readonly<{ error: OfferReadError | undefined }>) {
  const t = useT();
  return (
    <FormPage
      back={{ to: "/offers", label: t("offers.page.back") }}
      title={t("offers.page.title")}
      notices={
        error ? (
          <Banner
            variant="danger"
            message={t(READ_ERROR[error.kind])}
            requestId={error.requestId}
          />
        ) : (
          <ListState state="loading" label={t("offers.page.loadingNoun")} />
        )
      }
    >
      {null}
    </FormPage>
  );
}

interface WorkspaceProps {
  tenantId: string;
  tenantName: string;
  /** The saved offer; absent while creating. */
  offer: Offer | undefined;
  access: OfferAccess;
  storeScoped: boolean;
  onStale: () => void;
}

/** The editor (for a role that may edit) or the read-only facts, with the lifecycle beside either. */
function OfferWorkspace({
  tenantId,
  tenantName,
  offer,
  access,
  storeScoped,
  onStale,
}: Readonly<WorkspaceProps>): React.JSX.Element {
  const t = useT();
  const roster = usePayerStores(tenantId, true);
  const versions = useOfferVersions(offer ? tenantId : null, offer?.offerId);
  const writes = useOfferWrites(tenantId);
  const [notice, setNotice] = useState<OfferNotice | undefined>();
  const actions = offer ? offerActions(offer, access) : undefined;
  const title = nameOf(offer) ?? t(offer ? "offers.page.title" : "offers.page.newTitle");
  const subtitle = t.rich("offers.page.subtitle", { tenant: <bdi>{tenantName}</bdi> });
  const notices = <NoticeBanner notice={notice} />;
  const side =
    offer && actions ? (
      <OfferSide
        offer={offer}
        actions={actions}
        access={access}
        roster={roster}
        versions={versions.versions}
        storeScoped={storeScoped}
        writes={writes}
        onNotice={setNotice}
      />
    ) : null;

  if (!offer || actions?.edit) {
    return (
      <OfferEditor
        key={`${offer?.offerId ?? "new"}:${offer?.draft?.draftRevision ?? 0}`}
        tenantId={tenantId}
        offer={offer}
        access={access}
        roster={roster}
        writes={writes}
        title={title}
        subtitle={subtitle}
        notices={notices}
        after={side}
        onNotice={setNotice}
        onStale={onStale}
      />
    );
  }
  return (
    <FormPage
      back={{ to: "/offers", label: t("offers.page.back") }}
      title={title}
      subtitle={subtitle}
      notices={notices}
    >
      {side}
    </FormPage>
  );
}

export function OfferPage(): React.JSX.Element {
  const t = useT();
  const signOut = useSignOut();
  const { offerId } = useParams();
  const creating = offerId === undefined;
  const { tenant, tenantId, access, allowed, storeScoped } = usePageAccess(creating);
  const read = useOffer(allowed ? tenantId : null, offerId);

  if (!tenantId) return <ScopePrompt message={t("offers.list.scopePrompt")} />;
  if (!allowed) return <NoAccess onSignOut={signOut} />;
  if (!creating && !read.offer) return <OfferLoading error={read.error} />;
  return (
    <OfferWorkspace
      tenantId={tenantId}
      tenantName={tenant?.name ?? tenantId}
      offer={read.offer}
      access={access}
      storeScoped={storeScoped}
      onStale={() => void read.reload()}
    />
  );
}
