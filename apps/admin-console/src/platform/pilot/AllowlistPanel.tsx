/**
 * RT-1329: the "Allowlisted organizations" panel of the POS pilot page. The
 * allowlist carries tenant ids only; names come from the platform tenant list.
 * Add picks a tenant from that list (never a typed id); Remove sits behind an
 * inline confirm naming the organization and its consequence.
 */
import { Banner } from "@/components/Banner";
import { DataTableScroll, useCaptionId } from "@/components/DataTableScroll";
import { DetailPanel, PanelBody } from "@/components/DetailPanel";
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

function noticeOf(t: T, outcome: WriteOutcome<Kind>, name: string): PilotNotice {
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

function TenantName({ row }: Readonly<{ row: AllowlistRow }>) {
  const t = useT();
  if (row.name) return <bdi>{row.name}</bdi>;
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
  onRemove,
}: Readonly<{ rows: AllowlistRow[]; onRemove: (row: AllowlistRow) => void }>) {
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
                <TenantName row={row} />
              </td>
              <td>
                <DateTime value={row.addedAt} />
              </td>
              <td>
                <button
                  type="button"
                  className="btn-danger-quiet"
                  aria-label={t("posPilot.allowlist.removeFor", {
                    name: row.name ?? row.tenantId,
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

function AddTenant({
  tenants,
  directoryFailed,
  pending,
  onAdd,
}: Readonly<{
  tenants: (DirectoryTenant & { id: string })[];
  directoryFailed: boolean;
  pending: boolean;
  onAdd: (tenant: DirectoryTenant & { id: string }) => void;
}>) {
  const t = useT();
  const selectId = useId();
  const [picked, setPicked] = useState("");
  if (directoryFailed) {
    return <p className="pos-pilot__muted">{t("posPilot.add.directoryFailed")}</p>;
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
              {x.name ?? x.slug ?? x.id}
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
            directoryFailed={Boolean(directory.error)}
            pending={add.pending}
            onAdd={(tenant) => {
              setNotice(null);
              void settle(add.run(tenant.id), tenant.name ?? tenant.id);
            }}
          />
        </PanelBody>
      ) : null}
      {removing ? (
        <PilotConfirm
          label={t("posPilot.remove.label")}
          prompt={t.rich("posPilot.remove.prompt", {
            name: (
              <strong>
                <bdi>{removing.name ?? removing.tenantId}</bdi>
              </strong>
            ),
          })}
          confirmLabel={t("posPilot.remove.confirm")}
          tone="destructive"
          pending={remove.pending}
          onConfirm={() => {
            const row = removing;
            void settle(remove.run(row.tenantId), row.name ?? row.tenantId).then(() =>
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
            onRemove={(row) => {
              setNotice(null);
              setRemoving(row);
            }}
          />
        )}
      </PilotListBody>
    </DetailPanel>
  );
}
