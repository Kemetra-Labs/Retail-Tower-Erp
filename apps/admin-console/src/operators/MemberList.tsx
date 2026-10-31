import { Avatar } from "@/components/Avatar";
import { Banner } from "@/components/Banner";
import { type BandFacts, ListHeaderBand } from "@/components/ListHeaderBand";
import { ListState } from "@/components/ListState";
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { type T, useT } from "@/i18n";
import "@/components/avatar.css";
/**
 * SF5-1 — Member list (T012/T013). The membership graph for the active tenant,
 * rendered as a table grouped by role (DESIGN.md rule 7): Member (name over mono
 * email), Role, Store access (All stores / N stores — ids/count not names,
 * OQ-3), State (Revoked badge when revoked_at). Page header + right-aligned
 * "Invite member" primary.
 *
 * Pre-call guard (FR-005-007): no active tenant → scope prompt, `listMembers`
 * never called (it has no precondition-401). `listMembers` documents only 404 →
 * uniform banner with request_id. The invite/edit drawers mount from here.
 *
 * RT-1014 (v4.0): the band's facts are the counts of the whole list — total,
 * active, revoked — because `listMembers` is unpaged (an array, no paging
 * parameters); they appear only after a successful read of at least one member,
 * never while loading, on a 404 or on the empty state. The first fact carries an
 * avatar pile of the loaded active members. Every state sits in one v4 panel
 * (the 404 banner stays below the band, outside it).
 */
import { useState } from "react";
import { EditMember } from "./EditMember";
import { InviteMember } from "./InviteMember";
import { MemberTable } from "./MemberTable";
import { OperatorScopePrompt } from "./OperatorScopePrompt";
import { memberCounts } from "./memberGroups";
import { type MemberRow, useMembers } from "./useMembers";
import "./users.css";
import "../shell/surface.css";

/** How many avatars the band's pile shows before «+N». */
const PILE_SIZE = 4;

/** The avatars of the loaded active members: decoration beside the served total. */
function AvatarPile({ rows }: Readonly<{ rows: readonly MemberRow[] }>): React.JSX.Element | null {
  const active = rows.filter((row) => !row.revoked);
  if (active.length === 0) return null;
  return (
    <span className="member-pile" aria-hidden="true">
      {active.slice(0, PILE_SIZE).map((row) => (
        <Avatar key={row.membershipId} name={row.displayName ?? row.email} size={28} />
      ))}
      {active.length > PILE_SIZE ? (
        <span className="member-pile__more">+{active.length - PILE_SIZE}</span>
      ) : null}
    </span>
  );
}

/** The band facts (C1): counts of the full list, named by what they count. */
function bandFacts(rows: readonly MemberRow[], t: T): BandFacts {
  const counts = memberCounts(rows);
  return [
    {
      label: t("operators.band.total"),
      value: (
        <span className="member-fact">
          <AvatarPile rows={rows} />
          <span>{counts.total}</span>
        </span>
      ),
    },
    { label: t("operators.band.active"), value: counts.active },
    { label: t("operators.band.revoked"), value: counts.revoked },
  ];
}

export function MemberList(): React.JSX.Element {
  const t = useT();
  const { context } = useActiveContextValue();
  const rawTenant = context?.active_tenant ?? null;
  const { result, isLoading, refetch } = useMembers(rawTenant?.id ?? null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);

  // Pre-call guard: no active tenant -> scope prompt, listMembers never issued.
  if (!rawTenant?.id) {
    return <OperatorScopePrompt />;
  }
  const activeTenant = { id: rawTenant.id, name: rawTenant.name ?? rawTenant.id };

  const rows = result?.kind === "rows" ? result.rows : [];
  const notFound = result?.kind === "not-found" ? { requestId: result.requestId } : undefined;
  const hasRows = !isLoading && !notFound && rows.length > 0;

  return (
    <div className="surface">
      {/* Single-primary (DESIGN.md 6): header invite shows only when there are
          rows; the empty state carries its own invite primary. */}
      <ListHeaderBand
        group={t("shell.nav.section.management")}
        title={t("operators.title")}
        subtitle={t.rich("operators.list.subtitle", { tenant: <bdi>{activeTenant.name}</bdi> })}
        facts={
          hasRows ? { label: t("operators.band.label"), items: bandFacts(rows, t) } : undefined
        }
        actions={
          hasRows ? (
            <button type="button" className="btn-primary" onClick={() => setInviting(true)}>
              {t("operators.list.invite")}
            </button>
          ) : null
        }
      />

      {notFound ? (
        <Banner
          variant="danger"
          message={t("operators.list.notFound")}
          requestId={notFound.requestId}
        />
      ) : null}

      {notFound ? null : (
        <div className="section-panel members-panel">
          {hasRows ? (
            <header className="section-panel__head">
              <h2 className="section-panel__title">{t("operators.list.section")}</h2>
              <p className="members-panel__note">{t("operators.list.sectionNote")}</p>
            </header>
          ) : null}

          {isLoading ? <ListState state="loading" label={t("operators.list.loadingNoun")} /> : null}

          {!isLoading && rows.length === 0 ? (
            <ListState
              state="empty"
              emptyMessage={t("operators.list.empty")}
              action={
                <button type="button" className="btn-primary" onClick={() => setInviting(true)}>
                  {t("operators.list.invite")}
                </button>
              }
            />
          ) : null}

          {hasRows ? <MemberTable rows={rows} onOpen={setEditing} /> : null}
        </div>
      )}

      {inviting ? (
        <InviteMember
          activeTenant={activeTenant}
          onClose={() => setInviting(false)}
          onInvited={() => {
            setInviting(false);
            refetch();
          }}
        />
      ) : null}

      {editing ? (
        <EditMember
          activeTenantId={activeTenant.id}
          member={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            refetch();
          }}
        />
      ) : null}
    </div>
  );
}
