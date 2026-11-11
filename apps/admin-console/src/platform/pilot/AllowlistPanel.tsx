/**
 * RT-1329: the "Allowlisted organizations" panel of the POS pilot page. The
 * allowlist carries tenant ids only; names come from the platform tenant list.
 * Add picks a tenant from that list (never a typed id); Remove sits behind an
 * inline confirm naming the organization and its consequence.
 */
import { Banner } from "@/components/Banner";
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel, PanelBody } from "@/components/DetailPanel";
import { isolate } from "@/components/FilterBar";
import { GatedButton } from "@/components/GatedButton";
import { DateTime, type T, useT } from "@/i18n";
import { useId, useState } from "react";
import { useClaimRateLimit } from "../rateLimitOwner";
import { useTenantDirectory } from "../tenants/useTenantDirectory";
import { PilotConfirm, type PilotNotice, commonNotice } from "./PilotConfirm";
import { PilotListBody } from "./PilotListBody";
import {
  type AddKind,
  type AllowlistRow,
  type DirectoryTenant,
  type RemoveKind,
  addableTenants,
  allowlistRows,
} from "./pilotLogic";
import {
  type WriteOutcome,
  useAddPilotTenant,
  usePilotTenants,
  useRemovePilotTenant,
} from "./usePosPilot";

type Kind = AddKind | RemoveKind;

function noticeOf(t: T, outcome: WriteOutcome<Kind>, raw: string): PilotNotice {
  // A name in either script (or an id) in plain text: isolated so it never reorders.
  const name = isolate(raw);
  switch (outcome.kind) {
    case "added":
      return { variant: "success", message: t("posPilot.add.done", { name }) };
    case "alreadyListed":
      return { variant: "info", message: t("posPilot.add.alreadyListed", { name }) };
    case "tenantNotFound":
      return { variant: "warning", message: t("posPilot.add.tenantNotFound") };
    case "removed":
      return { variant: "success", message: t("posPilot.remove.done", { name }) };
    default:
      return commonNotice(t, outcome);
  }
}

/** One name per tenant everywhere on the page: name, else slug, else id. */
function labelOf(tenant: { name?: string; slug?: string }, id: string): string {
  return tenant.name ?? tenant.slug ?? id;
}

function TenantName({ row, namesKnown }: Readonly<{ row: AllowlistRow; namesKnown: boolean }>) {
  const t = useT();
  if (row.name) return <bdi>{row.name}</bdi>;
  // Names not read yet (or the read failed): the id alone, never "unknown".
  if (!namesKnown) {
    return (
      <bdi dir="ltr" className="pos-pilot__mono">
        {row.tenantId}
      </bdi>
    );
  }
  return (
    <span className="pos-pilot__who">
      <span>{t("posPilot.allowlist.unknownTenant")}</span>
      <bdi dir="ltr" className="pos-pilot__mono pos-pilot__muted">
        {row.tenantId}
      </bdi>
    </span>
  );
}

function AllowlistTable({
  rows,
  namesKnown,
  onRemove,
}: Readonly<{
  rows: AllowlistRow[];
  namesKnown: boolean;
  onRemove: (row: AllowlistRow) => void;
}>) {
  const t = useT();
  const captionId = useCaptionId();
  return (
    <DataTableScroll captionId={captionId}>
      <table className="data-table data-table--strips">
        <caption id={captionId} className="data-table__caption">
          {t("posPilot.allowlist.caption")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("posPilot.allowlist.col.tenant")}</th>
            <th scope="col">{t("posPilot.allowlist.col.added")}</th>
            <th scope="col">{t("posPilot.allowlist.col.action")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tenantId} className="data-table__row data-table__row--static">
              <td>
                <TenantName row={row} namesKnown={namesKnown} />
              </td>
              <td>
                <DateTime value={row.addedAt} />
              </td>
              <td>
                <button
                  type="button"
                  className="btn-danger-quiet"
                  aria-label={t("posPilot.allowlist.removeFor", {
                    name: labelOf(row, row.tenantId),
                  })}
                  onClick={() => onRemove(row)}
                >
                  {t("posPilot.allowlist.remove")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DataTableScroll>
  );
}

type Directory = ReturnType<typeof useTenantDirectory>;

function AddTenant({
  tenants,
  directory,
  pending,
  onAdd,
}: Readonly<{
  tenants: (DirectoryTenant & { id: string })[];
  directory: Directory;
  pending: boolean;
  onAdd: (tenant: DirectoryTenant & { id: string }) => void;
}>) {
  const t = useT();
  const selectId = useId();
  const [picked, setPicked] = useState("");
  if (directory.isLoading) {
    return <p className="pos-pilot__muted">{t("posPilot.add.loading")}</p>;
  }
  if (directory.error) {
    return (
      <div className="pos-pilot__add">
        <p className="pos-pilot__muted">{t("posPilot.add.directoryFailed")}</p>
        <GatedButton className="btn-secondary" onClick={directory.refetch}>
          {t("posPilot.retry")}
        </GatedButton>
      </div>
    );
  }
  if (tenants.length === 0) return <p className="pos-pilot__muted">{t("posPilot.add.none")}</p>;
  const chosen = tenants.find((x) => x.id === picked);
  return (
    <form
      className="pos-pilot__add"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen) {
          onAdd(chosen);
          setPicked("");
        }
      }}
    >
      <div className="field">
        <label htmlFor={selectId}>{t("posPilot.add.label")}</label>
        <select
          id={selectId}
          className="input"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="">{t("posPilot.add.placeholder")}</option>
          {tenants.map((x) => (
            <option key={x.id} value={x.id}>
              {labelOf(x, x.id)}
            </option>
          ))}
        </select>
      </div>
      <GatedButton type="submit" className="btn-primary" disabled={!chosen} busy={pending}>
        {t("posPilot.add.submit")}
      </GatedButton>
    </form>
  );
}

export function AllowlistPanel(): React.JSX.Element {
  const t = useT();
  const list = usePilotTenants();
  const directory = useTenantDirectory();
  const add = useAddPilotTenant();
  const remove = useRemovePilotTenant();
  const [removing, setRemoving] = useState<AllowlistRow | null>(null);
  const [notice, setNotice] = useState<PilotNotice | null>(null);
  const [claimSeq, setClaimSeq] = useState<number | undefined>(undefined);
  useClaimRateLimit(claimSeq);

  const pilot = list.items ?? [];
  const known = directory.tenants ?? [];
  const namesKnown = !directory.isLoading && !directory.error;

  async function settle<K extends Kind>(run: Promise<WriteOutcome<K>>, name: string) {
    const outcome = await run;
    setClaimSeq(outcome.seq);
    setNotice(noticeOf(t, outcome, name));
  }

  return (
    <DetailPanel id="pos-pilot-allowlist" index={2} title={t("posPilot.allowlist.panelTitle")}>
      {notice ? (
        <Banner variant={notice.variant} message={notice.message} requestId={notice.requestId} />
      ) : null}
      {list.items ? (
        <PanelBody>
          <AddTenant
            tenants={addableTenants(known, pilot)}
            directory={directory}
            pending={add.pending}
            onAdd={(tenant) => {
              setNotice(null);
              void settle(add.run(tenant.id), labelOf(tenant, tenant.id));
            }}
          />
        </PanelBody>
      ) : null}
      {removing ? (
        <PilotConfirm
          key={removing.tenantId}
          label={t("posPilot.remove.label")}
          prompt={t.rich("posPilot.remove.prompt", {
            name: (
              <strong>
                <bdi>{labelOf(removing, removing.tenantId)}</bdi>
              </strong>
            ),
          })}
          confirmLabel={t("posPilot.remove.confirm")}
          tone="destructive"
          pending={remove.pending}
          returnFocusId="pos-pilot-allowlist"
          onConfirm={() => {
            const row = removing;
            void settle(remove.run(row.tenantId), labelOf(row, row.tenantId)).then(() =>
              setRemoving(null),
            );
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
      <PilotListBody
        list={list}
        loadingLabel={t("posPilot.allowlist.panelTitle")}
        failedMessage={t("posPilot.allowlist.error.failed")}
        emptyMessage={t("posPilot.allowlist.empty")}
        emptyHint={t("posPilot.allowlist.emptyHint")}
      >
        {(items) => (
          <AllowlistTable
            rows={allowlistRows(items, known)}
            namesKnown={namesKnown}
            onRemove={(row) => {
              // A pending write keeps its own prompt: no retargeting mid-flight.
              if (remove.pending) return;
              setNotice(null);
              setRemoving(row);
            }}
          />
        )}
      </PilotListBody>
    </DetailPanel>
  );
}
